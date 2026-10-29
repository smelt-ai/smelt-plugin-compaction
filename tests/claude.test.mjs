// claude.js 和 agents.js 里 Claude Code 适配器的测试。在仓库根目录跑：node --test tests/

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CLAUDE_RESERVE,
  canonicalClaudeModel,
  claudeCurrent,
  claudeReader,
  claudeWindow,
  claudeWithOverride,
  claudeWithoutOverride,
} from "../engine/claude.js";
import { claude, pi } from "../engine/agents.js";

function assistant({ requestId, time, model = "claude-opus-5-5", input = 2, read = 1_000, write = 100, write1h = 0, out = 10 }) {
  return JSON.stringify({
    type: "assistant",
    requestId,
    timestamp: new Date(time).toISOString(),
    message: {
      id: `msg_${requestId}`,
      model,
      usage: {
        input_tokens: input,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: write,
        output_tokens: out,
        cache_creation: { ephemeral_5m_input_tokens: write - write1h, ephemeral_1h_input_tokens: write1h },
      },
    },
  });
}

test("规范模型名去掉日期和 [1m]", () => {
  assert.equal(canonicalClaudeModel("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
  assert.equal(canonicalClaudeModel("claude-opus-5-5[1m]"), "claude-opus-5-5");
  assert.equal(canonicalClaudeModel("claude-opus-5-5"), "claude-opus-5-5");
});

test("一次回复拆成几行只算一次，输出数取最大的", () => {
  const read = claudeReader("s.jsonl");
  const first = read(assistant({ requestId: "r1", time: 1_000, out: 3 }));
  assert.ok(first);
  assert.equal(first.prompt, 1_102);
  assert.equal(read(assistant({ requestId: "r1", time: 1_001, out: 40 })), null);
  assert.equal(first.out, 40);
  assert.ok(read(assistant({ requestId: "r2", time: 2_000 })));
});

test("一小时缓存的写入单独记", () => {
  const call = claudeReader("s.jsonl")(assistant({ requestId: "r", time: 1, write: 500, write1h: 300 }));
  assert.equal(call.wrote, 500);
  assert.equal(call.wrote1h, 300);
});

test("压缩边界之后的第一次调用标上 cut，耗时取 durationMs", () => {
  const read = claudeReader("s.jsonl");
  read(assistant({ requestId: "r1", time: 1_000 }));
  const boundary = JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    timestamp: new Date(2_000).toISOString(),
    compactMetadata: { trigger: "auto", preTokens: 900_000, durationMs: 50_758 },
  });
  assert.equal(read(boundary), null);
  const after = read(assistant({ requestId: "r2", time: 60_000 }));
  assert.equal(after.cut, true);
  assert.equal(after.compactMs, 50_758);
  assert.equal(read(assistant({ requestId: "r3", time: 61_000 })).cut, false);
});

test("合成的回复、用户行跳过", () => {
  const read = claudeReader("s.jsonl");
  assert.equal(read(assistant({ requestId: "x", time: 1, model: "<synthetic>" })), null);
  assert.equal(read(JSON.stringify({ type: "user", message: { content: '"type":"assistant","usage"' } })), null);
});

test("窗口按用过的最长提示词推", () => {
  assert.equal(claudeWindow([{ prompt: 150_000 }]), 200_000);
  assert.equal(claudeWindow([{ prompt: 150_000 }, { prompt: 400_000 }]), 1_000_000);
});

test("现在的压缩点：环境变量 > 按模型 > 顶层 > 默认", () => {
  const model = "claude-opus-5-5";
  assert.deepEqual(claudeCurrent({}, model, 1_000_000, null, {}), { value: 0, threshold: null, source: "default" });
  const top = { autoCompactWindow: 300_000 };
  assert.deepEqual(claudeCurrent(top, model, 1_000_000, null, {}), {
    value: 300_000,
    threshold: 300_000 - CLAUDE_RESERVE,
    source: "global",
  });
  const own = claudeWithOverride(top, model, 280_000);
  assert.equal(claudeCurrent(own, model, 1_000_000, null, {}).source, "user");
  assert.equal(claudeCurrent(own, model, 1_000_000, { value: 280_000 }, {}).source, "ours");
  assert.equal(claudeCurrent(own, model, 1_000_000, null, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000" }).source, "env");
  assert.equal(claudeCurrent({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "400000" } }, model, 1_000_000, null, {}).value, 400_000);
  assert.equal(claudeCurrent(top, model, 200_000, null, {}).value, 200_000, "设定超过窗口按窗口算");
});

test("写入、撤销不碰别的设置", () => {
  const settings = { model: "opus", modelSettings: { "claude-opus-5-5": { effortLevel: "high" } } };
  const next = claudeWithOverride(settings, "claude-opus-5-5", 280_000);
  assert.deepEqual(next.modelSettings["claude-opus-5-5"], { effortLevel: "high", autoCompactWindow: 280_000 });
  assert.equal(settings.modelSettings["claude-opus-5-5"].autoCompactWindow, undefined);
  assert.deepEqual(claudeWithoutOverride(next, "claude-opus-5-5"), settings);
  assert.deepEqual(claudeWithoutOverride(claudeWithOverride({ model: "opus" }, "m", 200_000), "m"), { model: "opus" });
});

test("适配器：Claude 的值在 10 万到 100 万之间，Pi 至少留 16384", () => {
  assert.throws(() => claude.apply({}, "m", 50_000, 1_000_000));
  assert.equal(claude.apply({}, "m", 300_000, 1_000_000).stored, 300_000);
  assert.throws(() => pi.apply({}, "p/m", 990_000, 1_000_000));
  assert.equal(pi.apply({}, "p/m", 256_000, 1_000_000).stored, 744_000);
  assert.equal(claude.tune(1_000_000).reserve, CLAUDE_RESERVE);
  assert.equal(pi.tune(1_000_000).max, 1_000_000 - 16_384);
});
