// 「压缩调优」：按你自己的用法，给 Pi 的每个模型算出最省的自动压缩点。
//
// 读会话、重放这些重活在子进程里做（engine/cli.js，跑在 smelt 自带的 smelt-pi 里，它是
// Bun 编出来的，带上 `BUN_BE_BUN=1` 就是一个 Bun），这里只起进程、读它一行行吐出来的
// JSON、画结果。插件脚本跑在 UI 线程上，几百 MB 的会话文件不能在这里读。
//
// 「采用」把压缩点写进 `~/.pi/agent/settings.json` 的 `compaction.modelOverrides`，
// 「撤销」删掉它；你自己给某个模型设过的值插件不碰。新开的 Pi 会话生效。

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  ErrorAlert,
  Tag,
  WarningAlert,
} from "gpui-component";
import process from "process";
import { stat } from "fs/promises";
import { join } from "path";
import { context } from "smelt-workspace";

import { formatTokens, formatPercent, formatSeconds, savings, SOURCE_LABELS } from "./format.js";

const SPACE = { xs: 4, sm: 8, md: 12, lg: 16 };
const MONO = "SF Mono, Menlo, monospace";
const MIN_CALLS = 50;

const PHASES = {
  scan: (event) => `正在读 Pi 的会话… ${event.done}/${event.total} 个文件`,
  windows: () => "正在取各模型的上下文窗口…",
  replay: () => "正在重放…",
};

export default class CompactionTune extends View {
  init(_props, cx) {
    this.home = context().home;
    /** analyze 的结果；没跑完是 null。 */
    this.result = null;
    this.error = null;
    /** 正在分析时是进度说明，没在分析时是 null。 */
    this.progress = null;
    /** 正在写入或撤销的模型。 */
    this.busy = null;
    /** 上一次写入、撤销的结果或错误，显示在顶上。 */
    this.notice = null;
    /** 每次分析递增，过时的结果丢掉。 */
    this.runId = 0;
    this.analyze(cx);
  }

  smeltPi() {
    return join(this.home, ".smelt", "bin", "smelt-pi");
  }

  /// 起引擎子进程。`onEvent(event, cx)` 收每一行事件；结束时返回错误说明，没出错是 null。
  async engine(args, onEvent) {
    const smeltPi = this.smeltPi();
    try {
      await stat(smeltPi);
    } catch {
      return `找不到 ${smeltPi}：先在 smelt 里开一次 Pi 对话，让它装好 Pi 运行时`;
    }
    const cli = decodeURIComponent(new URL("./engine/cli.js", import.meta.url).pathname);
    return new Promise((resolve) => {
      let failure = null;
      const stderr = [];
      // 子进程的环境变量是空的，用 env 补上 BUN_BE_BUN，主目录从参数传。
      const child = process.spawn("/usr/bin/env", ["BUN_BE_BUN=1", smeltPi, cli, ...args, "--home", this.home], {
        lines: true,
      });
      child.on("stdout", (line, cx) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === "error") failure = event.message;
        else onEvent(event, cx);
      });
      child.on("stderr", (line) => {
        stderr.push(line);
        if (stderr.length > 20) stderr.shift();
      });
      child.on("exit", (result) => {
        if (failure !== null) resolve(failure);
        else if (result.code === 0) resolve(null);
        else resolve(result.error ?? (stderr.join("\n") || `引擎退出码 ${result.code}`));
      });
    });
  }

  analyze(cx) {
    const id = ++this.runId;
    this.result = null;
    this.error = null;
    if (process.platform === "windows") {
      this.error = "暂时只支持 macOS 和 Linux";
      return;
    }
    this.progress = "正在启动…";
    cx.spawn(async (cx) => {
      const current = () => id === this.runId;
      const error = await this.engine(["analyze", "--smelt-pi", this.smeltPi()], (event, cx) => {
        if (!current()) return;
        if (event.type === "progress") this.progress = PHASES[event.phase]?.(event) ?? this.progress;
        else if (event.type === "result") this.result = event;
        cx.notify();
      });
      if (!current()) return;
      this.progress = null;
      if (error !== null) this.error = error;
      cx.notify();
    });
  }

  change(model, args, done, cx) {
    this.busy = model;
    this.notice = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let event = null;
      const error = await this.engine(args, (e) => {
        event = e;
      });
      this.busy = null;
      this.notice = error !== null ? { level: "error", text: error } : { level: "info", text: done(event) };
      if (error === null) this.analyze(cx);
      cx.notify();
    });
  }

  apply(entry, cx) {
    const threshold = entry.advice.best;
    this.change(
      entry.model,
      ["apply", "--model", entry.model, "--threshold", String(threshold), "--window", String(entry.window)],
      () => `${entry.model} 改成 ${formatTokens(threshold)} 时压缩，新开的 Pi 会话生效`,
      cx,
    );
  }

  undo(entry, cx) {
    this.change(
      entry.model,
      ["undo", "--model", entry.model],
      (event) =>
        event?.restored === false
          ? `settings.json 里 ${entry.model} 的值已经被改过，没有动它`
          : `${entry.model} 回到原来的压缩点，新开的 Pi 会话生效`,
      cx,
    );
  }

  render(cx) {
    const colors = cx.theme().colors;
    return v_flex()
      .size_full()
      .text_color(colors.foreground)
      .child(this.header(cx))
      .child(
        v_flex()
          .flex_1()
          .min_h_0()
          .overflow_y_scrollbar()
          .p(SPACE.lg)
          .gap(SPACE.lg)
          .children(this.body(cx)),
      );
  }

  header(cx) {
    const colors = cx.theme().colors;
    return h_flex()
      .items_center()
      .gap(SPACE.sm)
      .px(SPACE.lg)
      .py(SPACE.sm)
      .border_b(1)
      .border_color(colors.border)
      .child(div().text_sm().font_semibold().child("压缩调优"))
      .child(div().flex_1().min_w_0().text_xs().text_color(colors.muted_foreground).truncate().child("Pi"))
      .child(
        Button.new("reanalyze")
          .label(this.progress === null ? "重新分析" : "分析中…")
          .size("xsmall")
          .ghost()
          .disabled(this.progress !== null || this.busy !== null)
          .on_click((_event, cx) => {
            this.notice = null;
            this.analyze(cx);
            cx.notify();
          }),
      );
  }

  body(cx) {
    const items = [];
    if (this.notice !== null) {
      items.push(
        this.notice.level === "error"
          ? ErrorAlert.new("notice", this.notice.text).size("small")
          : hint(this.notice.text, cx),
      );
    }
    if (this.error !== null) {
      items.push(ErrorAlert.new("error", this.error).size("small"));
      return items;
    }
    if (this.result === null) {
      items.push(hint(this.progress ?? "", cx));
      return items;
    }
    const result = this.result;
    if (!result.autoCompaction) {
      items.push(WarningAlert.new("disabled", "Pi 的自动压缩关着（compaction.enabled = false），压缩点不会生效。").size("small"));
    }
    if (result.windowsError) {
      items.push(WarningAlert.new("windows", `取不到部分模型的窗口：${result.windowsError}`).size("small"));
    }
    if (result.models.length === 0) {
      items.push(empty("还没有 Pi 的会话", "用 Pi 聊过之后，这里会按你的用法算每个模型的压缩点。"));
      return items;
    }
    items.push(...result.models.map((entry) => this.card(entry, cx)));
    items.push(
      hint(
        `读了 ${result.files} 个会话文件（这次重读 ${result.filesRead} 个）。按价钱把缓存读、缓存写、输出折成普通输入 token，` +
          "把每个候选压缩点按你真实的对话重放一遍，取最省的；省不到 3% 不建议改。" +
          `写入 ${result.settingsPath} 的 compaction.modelOverrides，新开的 Pi 会话生效。`,
        cx,
      ),
    );
    return items;
  }

  card(entry, cx) {
    const colors = cx.theme().colors;
    const advice = entry.advice;
    const lines = [];
    const title = h_flex()
      .items_center()
      .gap(SPACE.sm)
      .child(div().flex_1().min_w_0().text_xs().font_family(MONO).truncate().child(entry.model))
      .child(
        entry.window === null
          ? tag("窗口未知", "warning")
          : tag(`窗口 ${entry.windowApprox ? "约 " : ""}${formatTokens(entry.window)}`, "secondary"),
      );
    lines.push(title);

    if (entry.current !== null) {
      lines.push(
        line("现在", `${formatTokens(entry.current.threshold)} 时压缩`, SOURCE_LABELS[entry.current.source], cx),
      );
    }
    if (advice === null) {
      lines.push(
        hint(
          entry.calls < MIN_CALLS
            ? `调用太少（${entry.calls} 次），至少 ${MIN_CALLS} 次才给建议。`
            : "窗口太小，没有可以试的压缩点。",
          cx,
        ),
      );
      if (entry.current?.source === "ours") lines.push(h_flex().justify_end().child(this.undoButton(entry)));
      return box(lines, cx);
    }

    const saving = savings(advice);
    const changed = entry.current !== null && advice.best !== entry.current.threshold;
    lines.push(
      line(
        "建议",
        `${formatTokens(advice.best)} 时压缩`,
        changed ? `省约 ${formatPercent(saving)}` : "现在就是最省的",
        cx,
      ),
    );
    if (changed) {
      const parts = [`压缩 ${advice.compacts} → ${advice.compactsBest} 次`];
      if (advice.facts.took > 0) {
        parts.push(`共等 ${formatSeconds(advice.wait)} → ${formatSeconds(advice.waitBest)}`);
      }
      lines.push(hint(`按这段时间的对话重放：${parts.join("，")}。`, cx));
    }
    lines.push(this.curve(entry, cx));
    lines.push(hint(facts(entry, advice), cx));

    const actions = [];
    if (entry.current?.source === "user") {
      lines.push(hint("你自己在 settings.json 里给这个模型设了 reserveTokens，插件不改。", cx));
    } else if (entry.current === null) {
      lines.push(hint("Pi 的模型列表里没有它，不知道窗口，没法写入。", cx));
    } else if (changed) {
      actions.push(
        Button.new(`apply-${entry.model}`)
          .label(`采用 ${formatTokens(advice.best)}`)
          .size("xsmall")
          .primary()
          .loading(this.busy === entry.model)
          .disabled(this.busy !== null || this.progress !== null)
          .on_click((_event, cx) => this.apply(entry, cx)),
      );
    }
    if (entry.current?.source === "ours") actions.push(this.undoButton(entry));
    if (actions.length > 0) lines.push(h_flex().gap(SPACE.sm).justify_end().children(actions));
    return box(lines, cx).border_color(changed ? colors.primary : colors.border);
  }

  undoButton(entry) {
    return Button.new(`undo-${entry.model}`)
      .label("撤销")
      .size("xsmall")
      .ghost()
      .loading(this.busy === entry.model)
      .disabled(this.busy !== null || this.progress !== null)
      .on_click((_event, cx) => this.undo(entry, cx));
  }

  /// 成本曲线：每个候选点一根柱，越高越费。建议的点用主色，现在的点用前景色。
  curve(entry, cx) {
    const colors = cx.theme().colors;
    const points = entry.advice.curve;
    const costs = points.map((p) => p.cost);
    const low = Math.min(...costs);
    const high = Math.max(...costs);
    const current = entry.current?.threshold ?? entry.advice.current;
    const nearest = points.reduce(
      (best, p, i) => (Math.abs(p.value - current) < Math.abs(points[best].value - current) ? i : best),
      0,
    );
    return v_flex()
      .gap(2)
      .child(
        h_flex()
          .h(40)
          .items_end()
          .gap(1)
          .children(
            points.map((p, i) =>
              div()
                .flex_1()
                .min_w(1)
                .h(high > low ? 4 + Math.round(((p.cost - low) / (high - low)) * 36) : 4)
                .rounded(1)
                .bg(p.value === entry.advice.best ? colors.primary : i === nearest ? colors.foreground : colors.border),
            ),
          ),
      )
      .child(
        h_flex()
          .text_xs()
          .text_color(colors.muted_foreground)
          .child(div().flex_1().child(formatTokens(points[0].value)))
          .child(div().child(formatTokens(points[points.length - 1].value))),
      );
  }
}

function facts(entry, advice) {
  const f = advice.facts;
  const parts = [`${entry.calls} 次调用、${f.streams} 段对话`];
  if (f.compacts > 0) {
    parts.push(`压缩过 ${f.compacts} 次，压缩前中位 ${formatTokens(f.peak)}、压缩后 ${formatTokens(f.after)}`);
    parts.push(`压缩后多读回 ${formatTokens(f.rework)}`);
  }
  parts.push(`每次调用上下文中位涨 ${formatTokens(f.growth)}`);
  return `${parts.join("；")}。`;
}

function line(label, value, note, cx) {
  const colors = cx.theme().colors;
  return h_flex()
    .items_center()
    .gap(SPACE.sm)
    .text_xs()
    .child(div().w(32).flex_none().text_color(colors.muted_foreground).child(label))
    .child(div().font_semibold().child(value))
    .child(div().flex_1().min_w_0().truncate().text_color(colors.muted_foreground).child(note));
}

function tag(text, variant) {
  return Tag.new().variant(variant).outline().size("xsmall").flex_none().child(text);
}

function box(children, cx) {
  const colors = cx.theme().colors;
  return v_flex()
    .gap(SPACE.sm)
    .p(SPACE.md)
    .border(1)
    .border_color(colors.border)
    .rounded(8)
    .children(children);
}

function hint(text, cx) {
  const colors = cx.theme().colors;
  return div().text_xs().whitespace_normal().text_color(colors.muted_foreground).child(text);
}

function empty(title, description) {
  return Empty.new().header(
    EmptyHeader.new().title(EmptyTitle.new().child(title)).description(EmptyDescription.new().child(description)),
  );
}
