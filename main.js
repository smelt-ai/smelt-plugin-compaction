// 「压缩调优」：按你自己的用法，给 Pi、Claude Code 的每个模型算出最省的自动压缩点。
//
// 读会话、重放这些重活在子进程里做（engine/cli.js，跑在 smelt 自带的 smelt-pi 里，它是
// Bun 编出来的，带上 `BUN_BE_BUN=1` 就是一个 Bun），这里只起进程、读它一行行吐出来的
// JSON、画结果。插件脚本跑在 UI 线程上，几百 MB 的会话文件不能在这里读。
//
// 「采用」把压缩点写进 agent 自己的设置（Pi 的 settings.json、Claude Code 的
// settings.json），「撤销」删掉它；你自己给某个模型设过的值插件不碰。新开的会话生效。

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

import { formatTokens, formatPercent, formatSeconds, savings, sourceLabel, WRITES_TO } from "./format.js";

const SPACE = { xs: 4, sm: 8, md: 12, lg: 16 };
const MONO = "SF Mono, Menlo, monospace";
const MIN_CALLS = 50;
const CLAUDE_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

const PHASES = {
  scan: (event) => `正在读 ${event.agent} 的会话… ${event.done}/${event.total} 个文件`,
  windows: (event) => `正在取 ${event.agent} 各模型的上下文窗口…`,
  replay: (event) => `正在重放 ${event.agent} 的对话…`,
};

export default class CompactionTune extends View {
  init(_props, cx) {
    this.home = context().home;
    /** analyze 的结果；没跑完是 null。 */
    this.result = null;
    this.error = null;
    /** 正在分析时是进度说明，没在分析时是 null。 */
    this.progress = null;
    /** 正在写入或撤销的那一张卡片的 key。 */
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
    const args = ["analyze", "--smelt-pi", this.smeltPi()];
    // 引擎看不到环境变量；smelt 带着这个变量启动的话，终端里的 Claude Code 也会继承它。
    if (process.env[CLAUDE_ENV]) args.push("--claude-env", process.env[CLAUDE_ENV]);
    cx.spawn(async (cx) => {
      const current = () => id === this.runId;
      const error = await this.engine(args, (event, cx) => {
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

  change(key, args, done, cx) {
    this.busy = key;
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

  apply(group, entry, cx) {
    const value = entry.advice.best;
    this.change(
      cardKey(group, entry),
      ["apply", "--agent", group.agent, "--model", entry.model, "--value", String(value), "--window", String(entry.window)],
      () => `${group.label} 的 ${entry.model} 改成约 ${formatTokens(value - entry.reserve)} 时压缩，新开的会话生效`,
      cx,
    );
  }

  undo(group, entry, cx) {
    this.change(
      cardKey(group, entry),
      ["undo", "--agent", group.agent, "--model", entry.model],
      (event) =>
        event?.restored === false
          ? `设置文件里 ${entry.model} 的值已经被改过，没有动它`
          : `${group.label} 的 ${entry.model} 回到原来的压缩点，新开的会话生效`,
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
      .child(div().flex_1().min_w_0().text_xs().text_color(colors.muted_foreground).truncate().child("Pi · Claude Code"))
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
    for (const group of this.result.agents) items.push(this.section(group, cx));
    items.push(
      hint(
        "按价钱把缓存读、缓存写、输出折成普通输入 token，把每个候选压缩点按你真实的对话重放一遍，" +
          "取最省的；省不到 3% 不建议改。改动只对新开的会话生效。",
        cx,
      ),
    );
    return items;
  }

  section(group, cx) {
    const colors = cx.theme().colors;
    const children = [];
    if (group.models.length === 0) {
      children.push(hint(`没有 ${group.label} 的会话。`, cx));
    } else {
      if (group.autoCompaction === false) {
        children.push(
          WarningAlert.new(`disabled-${group.agent}`, `${group.label} 的自动压缩关着，压缩点不会生效。`).size("small"),
        );
      }
      if (group.windowsError) {
        children.push(
          WarningAlert.new(`windows-${group.agent}`, `取不到部分模型的窗口：${group.windowsError}`).size("small"),
        );
      }
      children.push(...group.models.map((entry) => this.card(group, entry, cx)));
      children.push(
        hint(
          `读了 ${group.files} 个会话文件（这次重读 ${group.filesRead} 个）。采用时写进 ${group.settingsPath} 的 ${WRITES_TO[group.agent]}。`,
          cx,
        ),
      );
    }
    return v_flex()
      .gap(SPACE.sm)
      .child(div().text_xs().font_semibold().text_color(colors.muted_foreground).child(group.label))
      .children(children);
  }

  card(group, entry, cx) {
    const colors = cx.theme().colors;
    const advice = entry.advice;
    const key = cardKey(group, entry);
    const lines = [];
    lines.push(
      h_flex()
        .items_center()
        .gap(SPACE.sm)
        .child(div().flex_1().min_w_0().text_xs().font_family(MONO).truncate().child(entry.model))
        .child(
          entry.window === null
            ? tag("窗口未知", "warning")
            : tag(`窗口 ${entry.windowApprox ? "约 " : ""}${formatTokens(entry.window)}`, "secondary"),
        ),
    );

    // 现在在哪压缩：设置里写明了就用它；Claude Code 没设时它自己定，用你压缩过的位置推算。
    const known = entry.current?.threshold ?? null;
    const now = known ?? (advice ? advice.current - entry.reserve : null);
    if (now !== null) {
      const source = entry.current ? sourceLabel(group.agent, entry.current.source) : "按你的压缩记录推算";
      lines.push(line("现在", `${known === null ? "约 " : ""}${formatTokens(now)} 时压缩`, source, cx));
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
      if (entry.current?.source === "ours") lines.push(h_flex().justify_end().child(this.undoButton(group, entry, key)));
      return box(lines, cx);
    }

    const changed = advice.best !== advice.current;
    lines.push(
      line(
        "建议",
        `${formatTokens(advice.best - entry.reserve)} 时压缩`,
        changed ? `省约 ${formatPercent(savings(advice))}` : "现在就是最省的",
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
    if (advice.facts.compacts === 0) {
      lines.push(
        hint(
          `这个模型在你的记录里还没压缩过：压缩后剩多少（按对话开头加 1 万，约 ${formatTokens(advice.facts.afterUsed)}）` +
            `和返工（按 ${formatTokens(advice.facts.reworkUsed)}）都是估的，「省多少」只能参考。`,
          cx,
        ),
      );
    }
    if (changed && advice.best === advice.curve[0].value) {
      lines.push(hint("建议已经是可试范围的最低处：再低，压缩完剩下的上下文离压缩点太近，很快又要压。", cx));
    }

    const source = entry.current?.source;
    const actions = [];
    if (source === "user") {
      lines.push(hint("你自己在设置里给这个模型设了压缩点，插件不改。", cx));
    } else if (source === "env") {
      lines.push(hint(`环境变量 ${CLAUDE_ENV} 盖过设置文件，插件改了也不生效。`, cx));
    } else if (entry.current === null) {
      lines.push(hint("不知道这个模型的窗口，没法写入。", cx));
    } else if (changed) {
      actions.push(
        Button.new(`apply-${key}`)
          .label(`采用：${formatTokens(advice.best - entry.reserve)} 时压缩`)
          .size("xsmall")
          .primary()
          .loading(this.busy === key)
          .disabled(this.busy !== null || this.progress !== null)
          .on_click((_event, cx) => this.apply(group, entry, cx)),
      );
    }
    if (source === "ours") actions.push(this.undoButton(group, entry, key));
    if (actions.length > 0) lines.push(h_flex().gap(SPACE.sm).justify_end().children(actions));
    const highlight = changed && (source === "default" || source === "global" || source === "ours");
    return box(lines, cx).border_color(highlight ? colors.primary : colors.border);
  }

  undoButton(group, entry, key) {
    return Button.new(`undo-${key}`)
      .label("撤销")
      .size("xsmall")
      .ghost()
      .loading(this.busy === key)
      .disabled(this.busy !== null || this.progress !== null)
      .on_click((_event, cx) => this.undo(group, entry, cx));
  }

  /// 成本曲线：每个候选点一根柱，越高越费。建议的点用主色，现在的点用前景色。
  curve(entry, cx) {
    const colors = cx.theme().colors;
    const advice = entry.advice;
    const points = advice.curve;
    const costs = points.map((p) => p.cost);
    const low = Math.min(...costs);
    const high = Math.max(...costs);
    const nearest = points.reduce(
      (best, p, i) => (Math.abs(p.value - advice.current) < Math.abs(points[best].value - advice.current) ? i : best),
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
                .bg(p.value === advice.best ? colors.primary : i === nearest ? colors.foreground : colors.border),
            ),
          ),
      )
      .child(
        h_flex()
          .text_xs()
          .text_color(colors.muted_foreground)
          .child(div().flex_1().child(`${formatTokens(points[0].value - entry.reserve)} 压缩`))
          .child(div().child(`${formatTokens(points[points.length - 1].value - entry.reserve)} 压缩`)),
      );
  }
}

function cardKey(group, entry) {
  return `${group.agent}-${entry.model}`;
}

function facts(entry, advice) {
  const f = advice.facts;
  const parts = [`${entry.calls} 次调用、${f.streams} 段对话`];
  if (f.compacts > 0) {
    parts.push(`压缩过 ${f.compacts} 次，压缩前中位 ${formatTokens(f.peak)}、压缩后 ${formatTokens(f.after)}`);
    parts.push(`压缩后多读回 ${formatTokens(f.rework)}`);
  }
  if (f.took > 0) parts.push(`一次压缩中位等 ${formatSeconds(f.took)}`);
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
