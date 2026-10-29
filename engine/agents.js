// 各个 agent 的适配器。重放和挑点（tune.js）只有一份，每个 agent 只说清：
// - 会话在哪、怎么读（`sessionsDir`、`reader`）
// - 模型窗口从哪来（`windows`）
// - 压缩点设在哪、什么意思（`settingsPath`、`tune`、`current`、`apply`、`undo`）
//
// 设定值 `value` 都是 tune.js 里的「设定」：agent 在 value − reserve 时压缩。Pi 的 reserve
// 记成 0、value 就是压缩点；Claude Code 的 value 是 autoCompactWindow。
//
// 这里只用 node:path 和纯计算，需要起进程的（Pi 的 --list-models）由 cli.js 传进来。

import { join } from "node:path";

import { weightsFor } from "./tune.js";
import { piReader, weightsFromCosts } from "./pi.js";
import { parseListModels, modelsJsonWindows, mergeWindows } from "./windows.js";
import {
  DEFAULT_RESERVE,
  autoCompactionEnabled,
  currentThreshold,
  overrideOf,
  withOverride,
  withoutOverride,
} from "./pi-settings.js";
import {
  CLAUDE_MAX_WINDOW,
  CLAUDE_MIN_WINDOW,
  CLAUDE_RESERVE,
  claudeCurrent,
  claudeOverrideOf,
  claudeReader,
  claudeWindow,
  claudeWithOverride,
  claudeWithoutOverride,
} from "./claude.js";

const STEP = 10_000;
const PI_MIN_THRESHOLD = 50_000;

export const pi = {
  id: "pi",
  label: "Pi",
  sessionsDir: (home) => join(home, ".pi", "agent", "sessions"),
  settingsPath: (home) => join(home, ".pi", "agent", "settings.json"),
  /** 写设置时要拿 Pi 的 proper-lockfile 锁。 */
  piLock: true,
  reserve: 0,
  reader: piReader,

  /** Pi 判断压缩用它目录里的窗口：`--list-models` 加 models.json 里的精确值。 */
  async windows(ctx) {
    const exact = modelsJsonWindows(await ctx.readJson(join(ctx.home, ".pi", "agent", "models.json"), {}));
    const listed = await ctx.listPiModels();
    if (listed.error) return { windows: exact, error: listed.error };
    return { windows: mergeWindows(parseListModels(listed.text), exact), error: null };
  },

  /** 压缩点最高到 窗口 − Pi 默认的留空：再高，最后一次回复可能装不下。 */
  tune(window) {
    const top = window - DEFAULT_RESERVE;
    return { min: PI_MIN_THRESHOLD, max: top, step: STEP, reserve: 0, window: top };
  },

  current(settings, model, window, applied) {
    const c = currentThreshold(settings, model, window, applied);
    return { value: c.threshold, threshold: c.threshold, source: c.source };
  },

  enabled: autoCompactionEnabled,

  weights: (calls, model) => weightsFromCosts(calls, weightsFor(model)),

  /** 文件里按模型的值（存进 applied 的也是它：reserveTokens）。 */
  existing: overrideOf,

  apply(settings, model, value, window) {
    const reserve = window - value;
    if (reserve < DEFAULT_RESERVE) throw new Error(`压缩点太靠近窗口：至少要留 ${DEFAULT_RESERVE}`);
    return { settings: withOverride(settings, model, reserve), stored: reserve };
  },

  undo: withoutOverride,
};

export const claude = {
  id: "claude",
  label: "Claude Code",
  sessionsDir: (home) => join(home, ".claude", "projects"),
  settingsPath: (home) => join(home, ".claude", "settings.json"),
  piLock: false,
  reserve: CLAUDE_RESERVE,
  reader: claudeReader,

  /** 会话里没记窗口，按用过多长的提示词推，所以都是约数。 */
  async windows(_ctx, byModel) {
    const windows = new Map();
    for (const [model, calls] of byModel) windows.set(model, { window: claudeWindow(calls), approx: true });
    return { windows, error: null };
  },

  tune(window) {
    const top = Math.min(window, CLAUDE_MAX_WINDOW);
    return { min: CLAUDE_MIN_WINDOW, max: top, step: STEP, reserve: CLAUDE_RESERVE, window: top };
  },

  current: (settings, model, window, applied, ctx) => claudeCurrent(settings, model, window, applied, ctx.env),

  // 自动压缩的开关在 ~/.claude.json，不在 settings.json；关掉的人少，不去读。
  enabled: () => true,

  weights: (_calls, model) => weightsFor(model),

  existing: claudeOverrideOf,

  apply(settings, model, value) {
    if (value < CLAUDE_MIN_WINDOW || value > CLAUDE_MAX_WINDOW) {
      throw new Error(`autoCompactWindow 要在 ${CLAUDE_MIN_WINDOW} 到 ${CLAUDE_MAX_WINDOW} 之间`);
    }
    return { settings: claudeWithOverride(settings, model, value), stored: value };
  },

  undo: claudeWithoutOverride,
};

export const AGENTS = [pi, claude];

export function agentById(id) {
  const agent = AGENTS.find((a) => a.id === id);
  if (!agent) throw new Error(`不认识的 agent：${id}`);
  return agent;
}
