// tune.js 的测试。在仓库根目录跑：node --test tests/

import { test } from "node:test";
import assert from "node:assert/strict";

import { advise, dedupe, median, observe, replay, streams, DEFAULT_WEIGHTS, MIN_CALLS } from "../engine/tune.js";

/** 一段对话：从 `start` 起每次调用涨 `growth`，`cutAt` 里的下标之前刚压缩过、回到 `after`。 */
function conversation(stream, { calls, start, growth, out = 500, cutAt = [], after = 0, t0 = 0 }) {
  const list = [];
  let prompt = start;
  for (let i = 0; i < calls; i++) {
    const cut = cutAt.includes(i);
    if (cut) prompt = after;
    list.push({ time: t0 + i * 1000, stream, prompt, out, wrote: growth, wrote1h: 0, cut, compactMs: 0 });
    prompt += growth;
  }
  return list;
}

const opts = (extra) => ({ min: 50_000, max: 983_616, step: 10_000, reserve: 0, window: 983_616, weights: DEFAULT_WEIGHTS, ...extra });

test("中位数取排序后中间那个", () => {
  assert.equal(median([]), 0);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 3);
});

test("按对话分组、组内按时间排", () => {
  const ss = streams([
    { stream: "b", time: 2 },
    { stream: "a", time: 5 },
    { stream: "b", time: 1 },
  ]);
  assert.deepEqual(
    ss.map((s) => s.map((c) => `${c.stream}${c.time}`)),
    [["a5"], ["b1", "b2"]],
  );
});

test("压缩由读取器标出：回退造成的骤降不算压缩，也不算增长", () => {
  const s = [
    { time: 1, stream: "x", prompt: 100_000, cut: false },
    { time: 2, stream: "x", prompt: 110_000, cut: false },
    // 回退：骤降，但没标 cut
    { time: 3, stream: "x", prompt: 40_000, cut: false },
    { time: 4, stream: "x", prompt: 50_000, cut: false },
  ];
  const facts = observe([s]);
  assert.equal(facts.compacts, 0);
  assert.equal(facts.growth, 10_000);
});

test("压缩前后、返工从标出的压缩里量", () => {
  const s = conversation("x", { calls: 30, start: 20_000, growth: 1_000, cutAt: [10], after: 30_000 });
  // 压缩后第 10 次调用比平常多读回 5000
  for (let i = 15; i < 30; i++) s[i].prompt += 5_000;
  const facts = observe([s]);
  assert.equal(facts.compacts, 1);
  assert.equal(facts.peak, 29_000);
  assert.equal(facts.after, 30_000);
  assert.equal(facts.rework, 5_000);
  assert.equal(facts.sessions, 1);
});

test("重放：越过压缩点就压缩，上下文回到摘要加返工", () => {
  const s = conversation("x", { calls: 10, start: 10_000, growth: 10_000 });
  const w = { read: 0, write: 0, write1h: 0, out: 0 };
  const r = replay([s], 50_000, 20_000, 10_000, 0, w, 0);
  // 10K 起每次涨 10K：涨到 60K 前压一次回 20K，再涨到 60K 前又压一次
  assert.equal(r.compacts, 2);
});

test("调用太少不给建议", () => {
  const calls = conversation("x", { calls: MIN_CALLS - 1, start: 20_000, growth: 5_000 });
  assert.equal(advise(calls, opts({ current: 983_616 })), null);
});

test("一路涨到快满的对话：建议比默认的 98% 早得多地压缩", () => {
  const calls = [];
  for (let i = 0; i < 10; i++) {
    calls.push(...conversation(`s${i}`, { calls: 190, start: 20_000, growth: 5_000, t0: i * 1e6 }));
  }
  const advice = advise(calls, opts({ current: 983_616 }));
  assert.ok(advice);
  assert.ok(advice.best < 983_616, `best = ${advice.best}`);
  assert.ok(advice.best >= advice.curve[0].value);
  assert.ok(advice.low < advice.cost * 0.97);
  assert.ok(advice.compactsBest > advice.compacts);
});

test("对话从来涨不大：省不到 3%，保持现在的设置", () => {
  const calls = [];
  for (let i = 0; i < 10; i++) {
    calls.push(...conversation(`s${i}`, { calls: 20, start: 20_000, growth: 2_000, t0: i * 1e6 }));
  }
  const advice = advise(calls, opts({ current: 983_616 }));
  assert.ok(advice);
  assert.equal(advice.best, 983_616);
  assert.equal(advice.low, advice.cost);
});

test("设定超过窗口按窗口算", () => {
  const calls = [];
  for (let i = 0; i < 5; i++) calls.push(...conversation(`s${i}`, { calls: 20, start: 20_000, growth: 1_000, t0: i * 1e6 }));
  const advice = advise(calls, opts({ current: 2_000_000, window: 183_616, max: 183_616 }));
  assert.equal(advice.current, 183_616);
  assert.ok(advice.curve.every((p) => p.value <= 183_616));
});

test("分叉复制的历史只算一次，留先出现的", () => {
  const original = conversation("a", { calls: 3, start: 10_000, growth: 1_000 });
  const copy = original.map((call) => ({ ...call, stream: "b" }));
  const tail = { ...original[2], stream: "b", time: 9_999, prompt: 50_000 };
  const kept = dedupe([...original, ...copy, tail]);
  assert.deepEqual(
    kept.map((call) => `${call.stream}${call.prompt}`),
    ["a10000", "a11000", "a12000", "b50000"],
  );
});

test("中途换到这个模型的对话不拿来算开头，用 agent 的开头补", () => {
  // 两段对话都在第 600 次调用、上下文 11.5 万时才换到这个模型。
  const calls = [];
  for (let i = 0; i < 2; i++) {
    const list = conversation(`s${i}`, { calls: 100, start: 115_000, growth: 5_000, t0: i * 1e6 });
    list.forEach((call, j) => (call.seq = 600 + j));
    calls.push(...list);
  }
  const guessed = advise(calls, opts({ current: 983_616 }));
  const based = advise(calls, opts({ current: 983_616, base: 20_000 }));
  assert.equal(guessed.facts.base, 115_000, "没有补的值时只能用中途的第一次");
  assert.equal(based.facts.base, 20_000);
  assert.equal(based.facts.afterUsed, 30_000);
  assert.ok(based.curve[0].value < guessed.curve[0].value);
});

test("从头开始的对话优先：seq 为 0 的才算开头", () => {
  const head = conversation("a", { calls: 60, start: 8_000, growth: 1_000 });
  head.forEach((call, j) => (call.seq = j));
  const mid = conversation("b", { calls: 60, start: 200_000, growth: 1_000, t0: 1e6 });
  mid.forEach((call, j) => (call.seq = 300 + j));
  const advice = advise([...head, ...mid], opts({ current: 983_616, base: 99_999 }));
  assert.equal(advice.facts.base, 8_000);
});

test("没压缩过的模型借同一个 agent 量到的压缩后大小和返工", () => {
  const calls = [];
  for (let i = 0; i < 5; i++) calls.push(...conversation(`s${i}`, { calls: 100, start: 5_000, growth: 5_000, t0: i * 1e6 }));
  const guessed = advise(calls, opts({ current: 983_616 }));
  assert.equal(guessed.facts.afterFrom, "guess");
  assert.equal(guessed.facts.afterUsed, 15_000);
  const pi = advise(calls, opts({ current: 983_616, assumedSummary: 30_000 }));
  assert.equal(pi.facts.afterUsed, 35_000);
  const borrowed = advise(calls, opts({ current: 983_616, after: 50_000, rework: 20_000 }));
  assert.equal(borrowed.facts.afterFrom, "agent");
  assert.equal(borrowed.facts.afterUsed, 50_000);
  assert.equal(borrowed.facts.reworkUsed, 20_000);
  // 压缩后剩得越多，压缩越不划算，建议的点就越靠后。
  assert.ok(borrowed.best >= guessed.best);
});

test("回退后重放的上下文跟着退回，不会凭空多出压缩", () => {
  // 涨到 90 万，回退到 20 万，再涨到 60 万；从没超过 98 万。
  const s = [];
  let t = 0;
  for (let p = 100_000; p <= 900_000; p += 100_000) s.push({ time: t++, stream: "x", prompt: p, out: 0, cut: false });
  for (let p = 200_000; p <= 600_000; p += 100_000) s.push({ time: t++, stream: "x", prompt: p, out: 0, cut: false });
  const w = { read: 0, write: 0, write1h: 0, out: 0 };
  assert.equal(replay([s], 983_616, 50_000, 10_000, 0, w, 0).compacts, 0);
});
