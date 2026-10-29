// format.js 的测试。在仓库根目录跑：node --test tests/

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatTokens, formatPercent, formatSeconds, savings, sourceLabel, regions } from "../format.js";

test("token 数按万显示", () => {
  assert.equal(formatTokens(8192), "8192");
  assert.equal(formatTokens(256_000), "25.6 万");
  assert.equal(formatTokens(250_000), "25 万");
  assert.equal(formatTokens(1_000_000), "100 万");
  assert.equal(formatTokens(983_616), "98.4 万");
});

test("百分比和时长", () => {
  assert.equal(formatPercent(0.123), "12%");
  assert.equal(formatPercent(0.034), "3.4%");
  assert.equal(formatSeconds(45), "45 秒");
  assert.equal(formatSeconds(720), "12 分钟");
  assert.equal(formatSeconds(5400), "1.5 小时");
});

test("省下的比例", () => {
  assert.equal(savings({ cost: 100, low: 80 }), 0.2);
  assert.equal(savings({ cost: 0, low: 0 }), 0);
});

test("来源说明按 agent 区分默认值", () => {
  assert.equal(sourceLabel("pi", "default"), "Pi 默认");
  assert.equal(sourceLabel("claude", "default"), "Claude Code 默认");
  assert.equal(sourceLabel("claude", "ours"), "插件设的");
});

test("曲线上的两段区域：比最省多花不到 5%、不到 10%", () => {
  const curve = [
    { value: 100, cost: 130 },
    { value: 110, cost: 104 },
    { value: 120, cost: 100 },
    { value: 130, cost: 103 },
    { value: 140, cost: 108 },
    { value: 150, cost: 120 },
  ];
  assert.deepEqual(regions(curve), [
    { tolerance: 0.05, from: 110, to: 130 },
    { tolerance: 0.1, from: 110, to: 140 },
  ]);
  assert.deepEqual(regions([]), []);
});
