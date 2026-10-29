// 界面上的数字和说法。纯函数，Node 里可测。

const SOURCE_LABELS = {
  ours: "插件设的",
  user: "你自己设的",
  global: "设置里的全局值",
  env: "环境变量 CLAUDE_CODE_AUTO_COMPACT_WINDOW",
};

const DEFAULT_LABELS = {
  pi: "Pi 默认",
  claude: "Claude Code 默认",
};

/** 压缩点从哪来，说给人听。 */
export function sourceLabel(agent, source) {
  return source === "default" ? (DEFAULT_LABELS[agent] ?? "默认") : (SOURCE_LABELS[source] ?? source);
}

/** 「采用」写到设置文件的哪一项。 */
export const WRITES_TO = {
  pi: "compaction.modelOverrides.<模型>.reserveTokens",
  claude: "modelSettings.<模型>.autoCompactWindow",
};

/** 256000 → `25.6 万`，1000000 → `100 万`，8192 → `8192`。 */
export function formatTokens(count) {
  if (!Number.isFinite(count)) return "—";
  if (Math.abs(count) < 10_000) return String(Math.round(count));
  const wan = count / 10_000;
  const text = wan >= 100 ? String(Math.round(wan)) : wan.toFixed(1).replace(/\.0$/, "");
  return `${text} 万`;
}

/** 0.123 → `12%`，0.004 → `0.4%`。 */
export function formatPercent(ratio) {
  const percent = ratio * 100;
  return percent >= 10 ? `${Math.round(percent)}%` : `${percent.toFixed(1).replace(/\.0$/, "")}%`;
}

/** 秒 → `45 秒`、`12 分钟`、`1.5 小时`。 */
export function formatSeconds(seconds) {
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1).replace(/\.0$/, "")} 小时`;
}

/** 照建议改能省下现在成本的几成。 */
export function savings(advice) {
  return advice.cost > 0 ? (advice.cost - advice.low) / advice.cost : 0;
}
