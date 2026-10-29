// 压缩点调优：拿一个人自己的模型调用，把每个候选压缩点按原样重放一遍，看哪个花得最少。
//
// 重放：每次调用的提示词按它当时真实长了多少来长，越过候选点就模拟一次压缩。一次压缩的
// 代价是读一遍整段上下文、写一份摘要、下一次调用把摘要写进缓存，以及压缩后那些调用把
// 摘要漏掉的文件和结果再读回来（返工）。返工量从这个人自己压缩过的会话里量出来。
//
// token 按厂商的价钱折成「一个普通输入 token」再相加：缓存读便宜、输出贵。算出来的点只对
// 这个人、这个模型成立，换个人的用法就是另一个答案。
//
// 算法移植自 magpie（github.com/yetone/magpie，internal/tune/tune.go，MIT 许可，见
// THIRD_PARTY_NOTICES.md）。和原版的差别：压缩发生在哪里由读取器直接标出（`cut`），
// 不再靠「提示词骤降」去猜，回退、分叉造成的骤降因此不会算成压缩。
//
// 只用纯 JavaScript，Node 和 Bun 都能跑，测试用 `node --test`。

/** 一次调用：
 * - `time`：毫秒时间戳
 * - `stream`：它所在的对话（一个会话文件）
 * - `prompt`：整段提示词，含缓存读写
 * - `out`：输出
 * - `wrote` / `wrote1h`：其中写进缓存的，和其中保留一小时的
 * - `cut`：这次调用之前刚压缩过
 * - `compactMs`：那次压缩让人等了多久，量不到是 0
 * @typedef {{ time: number, stream: string, prompt: number, out: number, wrote: number,
 *   wrote1h: number, cut: boolean, compactMs: number }} Call
 */

/** 各类 token 折成普通输入 token 的倍数。 */
export const DEFAULT_WEIGHTS = Object.freeze({ read: 0.1, write: 1, write1h: 1, out: 8 });

/** Anthropic 写缓存贵四分之一（一小时的贵一倍），输出便宜些。 */
export const ANTHROPIC_WEIGHTS = Object.freeze({ read: 0.1, write: 1.25, write1h: 2, out: 5 });

/** 少于这么多次调用不给建议。 */
export const MIN_CALLS = 50;
/** 压缩后数这么多次调用来量返工。 */
const REWORK_CALLS = 10;
/** 至少这么多次压缩量到了耗时，才把等待算进去。 */
const MIN_TIMED = 3;
/** 成本差在这个比例以内算一样：省不到这么多不建议改；有耗时时，在这个范围里挑压缩最少的。 */
const SAME_COST = 0.03;
/** 在最便宜的 1% 以内取最大的点：压缩越少，丢掉的越少。 */
const NEAR_LOWEST = 0.01;
/** 没见过压缩时，假设摘要比对话开头多这么多。 */
const ASSUMED_SUMMARY = 10_000;
/** 压缩见得少于这么多次时，返工至少按这么多算。 */
const ASSUMED_REWORK = 10_000;
const MIN_OBSERVED_COMPACTS = 5;

export function weightsFor(model) {
  return /(^|\/)claude/i.test(model) ? ANTHROPIC_WEIGHTS : DEFAULT_WEIGHTS;
}

export function median(xs) {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** 按对话分组，每组按时间排好。 */
export function streams(calls) {
  const by = new Map();
  for (const call of calls) {
    const list = by.get(call.stream);
    if (list) list.push(call);
    else by.set(call.stream, [call]);
  }
  return [...by.keys()].sort().map((key) => by.get(key).sort((a, b) => a.time - b.time));
}

/** 从这个人自己的调用里读出：对话怎么长、压缩前多长、压缩后剩多少、返工多少。 */
export function observe(ss) {
  const facts = { calls: 0, streams: 0, compacts: 0, peak: 0, after: 0, growth: 0, rework: 0, sessions: 0 };
  const peaks = [];
  const afters = [];
  const growths = [];
  const reworks = [];
  for (const s of ss) {
    facts.streams += 1;
    facts.calls += s.length;
    const ds = [];
    const cuts = [];
    for (let i = 1; i < s.length; i++) {
      if (s[i].cut) {
        peaks.push(s[i - 1].prompt);
        afters.push(s[i].prompt);
        cuts.push(i);
        continue;
      }
      const d = s[i].prompt - s[i - 1].prompt;
      if (d >= 0) ds.push(d);
    }
    if (cuts.length > 0) facts.sessions += 1;
    const g = median(ds);
    growths.push(...ds);
    // 压缩后那几次调用比平常多读回的：摘要漏掉的文件和结果。
    for (const at of cuts) {
      const end = at + REWORK_CALLS;
      if (end >= s.length) continue;
      let clean = true;
      for (let j = at + 1; j <= end; j++) {
        if (s[j].cut) clean = false;
      }
      if (clean) reworks.push(Math.max(0, s[end].prompt - s[at].prompt - REWORK_CALLS * g));
    }
  }
  facts.compacts = peaks.length;
  facts.peak = median(peaks);
  facts.after = median(afters);
  facts.growth = median(growths);
  facts.rework = median(reworks);
  return facts;
}

/** 对话开头的提示词（系统提示、工具），压缩会保留它。 */
function base(ss) {
  return median(ss.map((s) => s[0].prompt));
}

/** 压缩让人等的秒数中位数，和量到了几次；量到的少于 MIN_TIMED 次时是 0。 */
function took(calls) {
  const ms = calls.map((call) => call.compactMs).filter((value) => value > 0);
  if (ms.length < MIN_TIMED) return { took: 0, timed: ms.length };
  return { took: Math.round(median(ms) / 1000), timed: ms.length };
}

/**
 * 按 `threshold` 压缩时这些对话要花多少。返回 `{ cost, compacts, over }`，`over` 是越过
 * 压缩点的调用数。
 */
export function replay(ss, threshold, after, b, rework, w, write) {
  let cost = 0;
  let compacts = 0;
  let over = 0;
  const summary = Math.max(0, after - b);
  for (const s of ss) {
    let ctx = s[0].prompt;
    cost += ctx * write + s[0].out * w.out;
    for (let i = 1; i < s.length; i++) {
      let d = s[i].prompt - s[i - 1].prompt;
      // 这个人自己的压缩、回退不算增长：重放里上下文从它原来的地方接着长。
      if (d < 0 || s[i].cut) d = 0;
      if (ctx + d > threshold && ctx > after) {
        cost += ctx * w.read + summary * w.out + (summary + rework) * write;
        ctx = after + rework;
        compacts += 1;
      }
      if (ctx + d > threshold) over += 1;
      cost += ctx * w.read + d * write + s[i].out * w.out;
      ctx += d;
    }
  }
  return { cost, compacts, over };
}

function roundTo(value, step) {
  return step > 0 ? Math.floor((value + step / 2) / step) * step : value;
}

function roundUp(value, step) {
  return step > 0 ? Math.ceil(value / step) * step : value;
}

/**
 * 给一个模型的调用建议压缩点；调用太少、或者从没接近过任何压缩点时是 null。
 *
 * `opts`：
 * - `min` / `max` / `step`：候选范围
 * - `reserve`：agent 在设定值下面再留出的空，压缩实际发生在 设定值 − reserve
 * - `current`：现在的设定，0 表示没设，从这个人的压缩里推
 * - `window`：模型的窗口，设定不能超过它；0 表示不知道
 * - `weights`：各类 token 的折算；不给就按模型名猜
 */
export function advise(calls, opts) {
  const ss = streams(calls);
  const facts = observe(ss);
  if (facts.calls < MIN_CALLS || facts.streams === 0) return null;
  const w = opts.weights ?? weightsFor(calls[0].model ?? "");
  let write = w.write;
  let wrote = 0;
  let wrote1h = 0;
  for (const call of calls) {
    wrote += call.wrote;
    wrote1h += call.wrote1h;
  }
  facts.hour = wrote > 0 ? wrote1h / wrote : 0;
  if (facts.hour > 0.5) write = w.write1h;

  const b = base(ss);
  const after = facts.after || b + ASSUMED_SUMMARY;
  const rework = facts.compacts < MIN_OBSERVED_COMPACTS ? Math.max(facts.rework, ASSUMED_REWORK) : facts.rework;
  const reserve = opts.reserve ?? 0;

  let current = opts.current ?? 0;
  if (current === 0) {
    if (facts.compacts >= 3) current = roundTo(facts.peak + reserve, opts.step);
    else if (opts.window > 0) current = opts.window;
    else current = opts.max;
  }
  // 设定超过窗口时按窗口压。不知道窗口，就只受 max 限制。
  let top = opts.max;
  if (opts.window > 0) {
    current = Math.min(current, opts.window);
    top = Math.min(opts.max, opts.window);
  }
  // 压缩点离摘要太近会压了又压：上面至少留出摘要的一半，或者二十次调用的增长。
  const floor = Math.max(
    opts.min,
    roundUp(after + Math.max(after / 2, 20 * facts.growth) + reserve, opts.step),
  );
  Object.assign(facts, took(calls));
  if (facts.took === 0) facts.timed = 0;

  const run = (value) => {
    const r = replay(ss, Math.max(after + 1, value - reserve), after, b, rework, w, write);
    return { value, cost: r.cost, compacts: r.compacts, wait: r.compacts * facts.took };
  };
  const now = run(current);
  const curve = [];
  for (let value = floor; value <= top; value += opts.step) curve.push(run(value));
  if (curve.length === 0) return null;

  const low = curve.reduce((a, p) => (p.cost < a.cost ? p : a));
  let best = low;
  for (const p of curve) {
    if (p.cost <= low.cost * (1 + NEAR_LOWEST) && p.value > best.value) best = p;
  }
  const result = {
    current,
    window: opts.window ?? 0,
    cost: now.cost,
    curve,
    wait: now.wait,
  };
  // 量到了压缩耗时，就不让人等得比现在久：token 和秒没有共同单位，不拿猜的汇率去换。
  // 压缩不比现在频繁的点里取最便宜的；和它差不到 SAME_COST 的，取压缩最少、一样多时取大的。
  if (facts.took > 0) {
    const calm = curve.filter((p) => p.compacts <= now.compacts);
    best = now;
    if (calm.length > 0) {
      const cheapest = calm.reduce((a, p) => (p.cost < a.cost ? p : a));
      best = cheapest;
      for (const p of calm) {
        if (
          p.cost <= cheapest.cost * (1 + SAME_COST) &&
          (p.compacts < best.compacts || (p.compacts === best.compacts && p.value > best.value))
        ) {
          best = p;
        }
      }
    }
    result.cheapest = low.value;
    result.waitCheapest = low.wait;
  }
  result.compacts = now.compacts;
  result.best = best.value;
  result.low = best.cost;
  result.waitBest = best.wait;
  result.compactsBest = best.compacts;
  // 省不到 SAME_COST 就不建议改。
  if (result.cost <= 0 || (result.cost - result.low) / result.cost < SAME_COST) {
    result.best = current;
    result.low = result.cost;
    result.waitBest = result.wait;
    result.compactsBest = result.compacts;
  }
  const { over } = replay(ss, Math.max(after + 1, result.best - reserve), after, b, rework, w, write);
  facts.long = over / Math.max(1, facts.calls);
  result.facts = facts;
  return result;
}
