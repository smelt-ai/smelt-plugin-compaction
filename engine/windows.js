// Pi 各模型的上下文窗口。Pi 判断压缩用的就是它目录里的窗口，所以以 Pi 说的为准：
// - `smelt-pi --list-models` 列出能用的模型，窗口写成 `200K`、`1M`、`1.1M` 这种；
// - `~/.pi/agent/models.json` 里自己加的模型有精确的 `contextWindow`，有就用它。
//
// 只用纯 JavaScript，Node 和 Bun 都能跑。

/**
 * `200K`、`1M`、`16.4K`、`512` → `{ value, approx }`。带小数的是四舍五入过的，
 * 真实值可能差出半个最小单位。
 */
export function parseTokenCount(text) {
  const match = /^(\d+(?:\.\d+)?)([KM]?)$/.exec(text.trim());
  if (!match) return null;
  const unit = match[2] === "M" ? 1_000_000 : match[2] === "K" ? 1_000 : 1;
  return { value: Math.round(Number(match[1]) * unit), approx: match[1].includes(".") };
}

/** `--list-models` 的表格 → `Map<"provider/model", { window, approx }>`。 */
export function parseListModels(text) {
  const windows = new Map();
  for (const line of text.split(/\r?\n/)) {
    const [provider, model, context] = line.trim().split(/\s+/);
    if (!provider || !model || !context || provider === "provider") continue;
    const count = parseTokenCount(context);
    if (count) windows.set(`${provider}/${model}`, { window: count.value, approx: count.approx });
  }
  return windows;
}

/** `models.json` → `Map<"provider/model", { window, approx: false }>`。 */
export function modelsJsonWindows(json) {
  const windows = new Map();
  for (const [provider, config] of Object.entries(json?.providers ?? {})) {
    for (const model of config?.models ?? []) {
      if (typeof model?.id === "string" && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0) {
        windows.set(`${provider}/${model.id}`, { window: model.contextWindow, approx: false });
      }
    }
  }
  return windows;
}

/** 精确的盖过四舍五入的。 */
export function mergeWindows(listed, exact) {
  const merged = new Map(listed);
  for (const [key, value] of exact) merged.set(key, value);
  return merged;
}
