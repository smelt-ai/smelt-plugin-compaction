// 读 Pi 的会话文件（~/.pi/agent/sessions/**/*.jsonl）：每条助手消息带一次模型调用的
// usage，压缩是单独一条 `compaction`。一个文件是一段对话，按追加顺序读。
//
// 只用纯 JavaScript，Node 和 Bun 都能跑。

/** 压缩和它前面那次调用隔得比这还久，就不算压缩让人等的时间（中间多半是人走开了）。 */
const MAX_COMPACT_WAIT_MS = 30 * 60 * 1000;

/** Pi 在设置里认的模型名：`provider/model`。 */
export function piModelKey(provider, model) {
  return `${provider}/${model}`;
}

/**
 * 一个会话文件的读取器。按行喂进去，遇到一次模型调用就返回它，其它行返回 null。
 * 调用带上 usage 和费用，给按价钱折算 token 用。
 */
export function piReader(stream) {
  let cut = false;
  let compactMs = 0;
  /** 上一次调用结束的时刻。 */
  let lastEnd = null;
  return (line) => {
    // 工具结果、用户消息占了文件的绝大部分，先用子串挑掉，不去解析。
    // Pi 用 JSON.stringify 写，键值之间没有空格。
    const isCompaction = line.includes('"type":"compaction"');
    if (!isCompaction && !(line.includes('"role":"assistant"') && line.includes('"usage"'))) return null;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return null;
    }
    if (entry.type === "compaction") {
      cut = true;
      const at = Date.parse(entry.timestamp);
      compactMs = lastEnd !== null && at >= lastEnd && at - lastEnd <= MAX_COMPACT_WAIT_MS ? at - lastEnd : 0;
      return null;
    }
    const message = entry.type === "message" ? entry.message : null;
    if (!message || message.role !== "assistant" || !message.usage) return null;
    const usage = message.usage;
    const input = usage.input ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const prompt = input + cacheRead + cacheWrite;
    if (message.stopReason === "error" || prompt <= 0) return null;
    const time = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp);
    if (!Number.isFinite(time)) return null;
    const cost = usage.cost ?? {};
    const call = {
      time,
      stream,
      model: piModelKey(message.provider, message.model),
      prompt,
      out: usage.output ?? 0,
      wrote: cacheWrite,
      // Pi 的 usage 不分缓存保留五分钟还是一小时。
      wrote1h: 0,
      cut,
      compactMs: cut ? compactMs : 0,
      input,
      cacheRead,
      costInput: cost.input ?? 0,
      costOutput: cost.output ?? 0,
      costCacheRead: cost.cacheRead ?? 0,
      costCacheWrite: cost.cacheWrite ?? 0,
    };
    cut = false;
    compactMs = 0;
    lastEnd = time + (message.durationMs ?? 0);
    return call;
  };
}

/**
 * 按这个模型实际的价钱折算各类 token：缓存读、缓存写、输出各是普通输入的几倍。
 * 有哪一项算不出来（没花过钱、订阅不计费）就用 `fallback` 里的。
 */
export function weightsFromCosts(calls, fallback) {
  let input = 0;
  let costInput = 0;
  let read = 0;
  let costRead = 0;
  let write = 0;
  let costWrite = 0;
  let out = 0;
  let costOut = 0;
  for (const call of calls) {
    input += call.input;
    costInput += call.costInput;
    read += call.cacheRead;
    costRead += call.costCacheRead;
    write += call.wrote;
    costWrite += call.costCacheWrite;
    out += call.out;
    costOut += call.costOutput;
  }
  if (input <= 0 || costInput <= 0) return fallback;
  const unit = costInput / input;
  const ratio = (tokens, cost, otherwise) => (tokens > 0 && cost > 0 ? cost / tokens / unit : otherwise);
  const writeRatio = ratio(write, costWrite, fallback.write);
  return {
    read: ratio(read, costRead, fallback.read),
    write: writeRatio,
    write1h: writeRatio,
    out: ratio(out, costOut, fallback.out),
  };
}
