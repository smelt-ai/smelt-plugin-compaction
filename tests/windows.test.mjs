// windows.js 的测试。在仓库根目录跑：node --test tests/

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTokenCount, parseListModels, modelsJsonWindows, mergeWindows } from "../engine/windows.js";

test("整数的 K/M 是精确值，带小数的是约数", () => {
  assert.deepEqual(parseTokenCount("200K"), { value: 200_000, approx: false });
  assert.deepEqual(parseTokenCount("1M"), { value: 1_000_000, approx: false });
  assert.deepEqual(parseTokenCount("16.4K"), { value: 16_400, approx: true });
  assert.deepEqual(parseTokenCount("512"), { value: 512, approx: false });
  assert.equal(parseTokenCount("n/a"), null);
});

test("--list-models 的表格", () => {
  const text = [
    "provider         model                                  context  max-out  thinking  images",
    "commandcode      deepseek/deepseek-v4-flash             1M       16.4K    no        yes",
    "github-copilot   claude-opus-5.5                        200K     32K      yes       yes",
    "",
  ].join("\n");
  const windows = parseListModels(text);
  assert.equal(windows.size, 2);
  assert.deepEqual(windows.get("commandcode/deepseek/deepseek-v4-flash"), { window: 1_000_000, approx: false });
  assert.deepEqual(windows.get("github-copilot/claude-opus-5.5"), { window: 200_000, approx: false });
});

test("models.json 的精确窗口盖过表格里的约数", () => {
  const exact = modelsJsonWindows({
    providers: { relay: { models: [{ id: "big", contextWindow: 1_048_576 }, { id: "no-window" }] } },
  });
  assert.equal(exact.size, 1);
  const merged = mergeWindows(new Map([["relay/big", { window: 1_000_000, approx: true }]]), exact);
  assert.deepEqual(merged.get("relay/big"), { window: 1_048_576, approx: false });
});
