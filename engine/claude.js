// Claude Code：读 `~/.claude/projects/<项目>/<会话>.jsonl`（子代理在 `<会话>/subagents/`），
// 压缩点在 `~/.claude/settings.json`。
//
// 一次回复按内容块拆成几行写，每行带同一个 `requestId` 和同一份 usage，只算一次。
// 压缩是一条 `{"type":"system","subtype":"compact_boundary"}`，`compactMetadata.durationMs`
// 是这次压缩让人等了多久。
//
// 压缩点：Claude Code 在 `autoCompactWindow`（和模型窗口取小）再减去给回复留的空时压缩，
// 200K 的窗口约在 167K、1M 约在 967K。按模型的值写在 `modelSettings.<模型名>.autoCompactWindow`，
// 盖过顶层的 `autoCompactWindow`；环境变量 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 又盖过两者。
// 取值 100000 到 1000000。
//
// 只用纯 JavaScript，Node 和 Bun 都能跑。

/** Claude Code 在设定的窗口下再给回复留的空。 */
export const CLAUDE_RESERVE = 33_000;
export const CLAUDE_MIN_WINDOW = 100_000;
export const CLAUDE_MAX_WINDOW = 1_000_000;
/** 不带 [1m] 的 Claude 模型的窗口。 */
const STANDARD_WINDOW = 200_000;
const LONG_WINDOW = 1_000_000;
export const CLAUDE_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

/** `claude-haiku-4-5-20251001`、`claude-opus-5-5[1m]` → 设置里认的规范名。 */
export function canonicalClaudeModel(model) {
  return model.replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "");
}

export function claudeReader(stream) {
  let cut = false;
  let compactMs = 0;
  /** requestId → 已经算过的那次调用。后面同一次回复的行只补上输出数。 */
  const seen = new Map();
  return (line) => {
    const isBoundary = line.includes('"compact_boundary"');
    if (!isBoundary && !(line.includes('"type":"assistant"') && line.includes('"usage"'))) return null;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return null;
    }
    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      cut = true;
      const ms = entry.compactMetadata?.durationMs;
      compactMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
      return null;
    }
    const message = entry.type === "assistant" ? entry.message : null;
    const usage = message?.usage;
    if (!usage || typeof message.model !== "string" || message.model.startsWith("<")) return null;
    const id = entry.requestId ?? message.id ?? null;
    if (id !== null && seen.has(id)) {
      const call = seen.get(id);
      call.out = Math.max(call.out, usage.output_tokens ?? 0);
      return null;
    }
    const input = usage.input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const wrote = usage.cache_creation_input_tokens ?? 0;
    const prompt = input + cacheRead + wrote;
    const time = Date.parse(entry.timestamp);
    if (prompt <= 0 || !Number.isFinite(time)) return null;
    const call = {
      time,
      stream,
      model: canonicalClaudeModel(message.model),
      prompt,
      out: usage.output_tokens ?? 0,
      wrote,
      wrote1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      cut,
      compactMs: cut ? compactMs : 0,
      input,
      cacheRead,
      // 会话里没有费用，按 Anthropic 的价钱比例折算（tune.js 的 weightsFor）。
      costInput: 0,
      costOutput: 0,
      costCacheRead: 0,
      costCacheWrite: 0,
    };
    if (id !== null) seen.set(id, call);
    cut = false;
    compactMs = 0;
    return call;
  };
}

/** 会话里没记模型窗口：用过超过 200K 的提示词就是 1M 的，否则按 200K 算。 */
export function claudeWindow(calls) {
  const longest = calls.reduce((most, call) => Math.max(most, call.prompt), 0);
  return longest > STANDARD_WINDOW ? LONG_WINDOW : STANDARD_WINDOW;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function windowValue(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** 这个模型按模型设的 autoCompactWindow，没有是 null。 */
export function claudeOverrideOf(settings, model) {
  return windowValue(settings?.modelSettings?.[model]?.autoCompactWindow);
}

/**
 * 这个模型现在在哪压缩。`value` 是设定的窗口，`threshold` 是真正压缩的地方。
 * `source`：`env`（环境变量，插件改不了）、`ours`、`user`、`global`（顶层设置）、`default`。
 * `default` 时 Claude Code 用它自己给模型调的窗口，具体多少不知道，`value` 是 0。
 */
export function claudeCurrent(settings, model, window, applied, env) {
  const fromEnv = windowValue(Number(env?.[CLAUDE_ENV] ?? settings?.env?.[CLAUDE_ENV]));
  const override = claudeOverrideOf(settings, model);
  const top = windowValue(settings?.autoCompactWindow);
  let value;
  let source;
  if (fromEnv !== null) {
    value = fromEnv;
    source = "env";
  } else if (override !== null) {
    value = override;
    source = applied && applied.value === override ? "ours" : "user";
  } else if (top !== null) {
    value = top;
    source = "global";
  } else {
    return { value: 0, threshold: null, source: "default" };
  }
  const effective = Math.min(value, window);
  return { value: effective, threshold: effective - CLAUDE_RESERVE, source };
}

export function claudeWithOverride(settings, model, value) {
  const next = structuredClone(isObject(settings) ? settings : {});
  if (!isObject(next.modelSettings)) next.modelSettings = {};
  const entry = isObject(next.modelSettings[model]) ? next.modelSettings[model] : {};
  entry.autoCompactWindow = value;
  next.modelSettings[model] = entry;
  return next;
}

export function claudeWithoutOverride(settings, model) {
  const next = structuredClone(isObject(settings) ? settings : {});
  const entry = next.modelSettings?.[model];
  if (!isObject(entry)) return next;
  delete entry.autoCompactWindow;
  if (Object.keys(entry).length === 0) delete next.modelSettings[model];
  if (Object.keys(next.modelSettings).length === 0) delete next.modelSettings;
  return next;
}
