// Pi 的压缩点在 `~/.pi/agent/settings.json` 里：上下文超过「窗口 − reserveTokens」就压缩。
// 按模型的值写在 `compaction.modelOverrides["provider/model"].reserveTokens`，盖过全局的
// `compaction.reserveTokens`，再没有就是 Pi 默认的 16384。
//
// 这里只做纯计算：读出现在的压缩点、算出写入或撤销后的整份设置。读写文件和加锁在 cli.js。

/** Pi 默认留出的空，也是这里允许留的最少：再少，最后一次回复可能装不下。 */
export const DEFAULT_RESERVE = 16384;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reserveAt(settings, key) {
  const value = settings?.compaction?.modelOverrides?.[key]?.reserveTokens;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 这个模型按模型设的 reserveTokens，没有是 null。 */
export function overrideOf(settings, key) {
  return reserveAt(settings, key);
}

/**
 * 这个模型现在在哪压缩。`source`：
 * - `ours`：本插件写的（`applied.value` 记着、文件里还是那个值）
 * - `user`：按模型的值，不是本插件写的
 * - `global`：全局的 `compaction.reserveTokens`
 * - `default`：Pi 默认
 */
export function currentThreshold(settings, key, window, applied) {
  const override = reserveAt(settings, key);
  let reserve;
  let source;
  if (override !== null) {
    reserve = override;
    source = applied && applied.value === override ? "ours" : "user";
  } else if (Number.isSafeInteger(settings?.compaction?.reserveTokens) && settings.compaction.reserveTokens >= 0) {
    reserve = settings.compaction.reserveTokens;
    source = "global";
  } else {
    reserve = DEFAULT_RESERVE;
    source = "default";
  }
  return { threshold: Math.max(0, window - reserve), reserve, source };
}

/** Pi 是否开着自动压缩。 */
export function autoCompactionEnabled(settings) {
  return settings?.compaction?.enabled !== false;
}

/** 写上这个模型的 reserveTokens 后的整份设置。不改动传进来的对象。 */
export function withOverride(settings, key, reserve) {
  const next = structuredClone(isObject(settings) ? settings : {});
  if (!isObject(next.compaction)) next.compaction = {};
  if (!isObject(next.compaction.modelOverrides)) next.compaction.modelOverrides = {};
  const entry = isObject(next.compaction.modelOverrides[key]) ? next.compaction.modelOverrides[key] : {};
  entry.reserveTokens = reserve;
  next.compaction.modelOverrides[key] = entry;
  return next;
}

/**
 * 撤销：删掉这个模型的 reserveTokens，删空的对象一并删。不改动传进来的对象。
 * 已有按模型的值时不会写入（见 cli.js 的 apply），所以撤销不用放回什么。
 */
export function withoutOverride(settings, key) {
  const next = structuredClone(isObject(settings) ? settings : {});
  const overrides = next.compaction?.modelOverrides;
  if (!isObject(overrides) || !isObject(overrides[key])) return next;
  delete overrides[key].reserveTokens;
  if (Object.keys(overrides[key]).length === 0) delete overrides[key];
  if (Object.keys(overrides).length === 0) delete next.compaction.modelOverrides;
  if (Object.keys(next.compaction).length === 0) delete next.compaction;
  return next;
}
