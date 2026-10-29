// pi.js 的测试。在仓库根目录跑：node --test tests/

import { test } from "node:test";
import assert from "node:assert/strict";

import { piReader, weightsFromCosts } from "../engine/pi.js";

function assistant({ time, input = 100, cacheRead = 0, cacheWrite = 0, output = 50, stopReason = "toolUse", cost = {}, durationMs = 0 }) {
  return JSON.stringify({
    type: "message",
    id: `m${time}`,
    timestamp: new Date(time).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      provider: "commandcode",
      model: "deepseek/deepseek-v4-flash",
      usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost },
      stopReason,
      timestamp: time,
      durationMs,
    },
  });
}

test("助手消息变成一次调用，提示词含缓存读写，模型名是 provider/model", () => {
  const read = piReader("a.jsonl");
  const call = read(assistant({ time: 1000, input: 10, cacheRead: 200, cacheWrite: 30, output: 7 }));
  assert.equal(call.stream, "a.jsonl");
  assert.equal(call.model, "commandcode/deepseek/deepseek-v4-flash");
  assert.equal(call.prompt, 240);
  assert.equal(call.out, 7);
  assert.equal(call.wrote, 30);
  assert.equal(call.cut, false);
});

test("工具结果、用户消息、坏行都跳过", () => {
  const read = piReader("a.jsonl");
  const tool = JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: '"role":"assistant"' }] } });
  assert.equal(read(tool), null);
  assert.equal(read(JSON.stringify({ type: "message", message: { role: "user", content: "hi" } })), null);
  assert.equal(read('{"type":"message","message":{"role":"assistant","usage"'), null);
  assert.equal(read(""), null);
});

test("出错的回复、没有提示词的回复不算", () => {
  const read = piReader("a.jsonl");
  assert.equal(read(assistant({ time: 1, stopReason: "error" })), null);
  assert.equal(read(assistant({ time: 2, input: 0 })), null);
});

test("压缩之后的第一次调用标上 cut，带上压缩等了多久", () => {
  const read = piReader("a.jsonl");
  read(assistant({ time: 10_000, durationMs: 2_000 }));
  const compaction = JSON.stringify({ type: "compaction", timestamp: new Date(42_000).toISOString(), summary: "…", tokensBefore: 900_000 });
  assert.equal(read(compaction), null);
  const after = read(assistant({ time: 50_000 }));
  assert.equal(after.cut, true);
  assert.equal(after.compactMs, 30_000);
  const next = read(assistant({ time: 60_000 }));
  assert.equal(next.cut, false);
  assert.equal(next.compactMs, 0);
});

test("压缩和前一次调用隔得太久，不算压缩耗时", () => {
  const read = piReader("a.jsonl");
  read(assistant({ time: 0 }));
  read(JSON.stringify({ type: "compaction", timestamp: new Date(2 * 60 * 60 * 1000).toISOString() }));
  const after = read(assistant({ time: 2 * 60 * 60 * 1000 + 1 }));
  assert.equal(after.cut, true);
  assert.equal(after.compactMs, 0);
});

test("按实际价钱折算：缓存读、输出是输入的几倍", () => {
  const fallback = { read: 0.1, write: 1, write1h: 1, out: 8 };
  const calls = [
    { input: 1_000, costInput: 1, cacheRead: 10_000, costCacheRead: 2, wrote: 0, costCacheWrite: 0, out: 100, costOutput: 0.4 },
  ];
  const w = weightsFromCosts(calls, fallback);
  assert.ok(Math.abs(w.read - 0.2) < 1e-9);
  assert.ok(Math.abs(w.out - 4) < 1e-9);
  assert.equal(w.write, 1, "没写过缓存，用后备值");
});

test("不计费的（订阅）用后备折算", () => {
  const fallback = { read: 0.1, write: 1, write1h: 1, out: 8 };
  const calls = [{ input: 1_000, costInput: 0, cacheRead: 0, costCacheRead: 0, wrote: 0, costCacheWrite: 0, out: 1, costOutput: 0 }];
  assert.equal(weightsFromCosts(calls, fallback), fallback);
});
