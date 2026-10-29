// format.js 的测试。在仓库根目录跑：node --test tests/

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatTokens, formatPercent, formatSeconds, savings } from "../format.js";

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
