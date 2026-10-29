// pi-settings.js 的测试。在仓库根目录跑：node --test tests/

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RESERVE,
  autoCompactionEnabled,
  currentThreshold,
  withOverride,
  withoutOverride,
} from "../engine/pi-settings.js";

const KEY = "commandcode/deepseek/deepseek-v4-flash";

test("没设过：Pi 默认留 16384", () => {
  assert.deepEqual(currentThreshold({}, KEY, 1_000_000, null), {
    threshold: 1_000_000 - DEFAULT_RESERVE,
    reserve: DEFAULT_RESERVE,
    source: "default",
  });
});

test("全局的 reserveTokens", () => {
  const settings = { compaction: { reserveTokens: 40_000 } };
  assert.equal(currentThreshold(settings, KEY, 200_000, null).source, "global");
  assert.equal(currentThreshold(settings, KEY, 200_000, null).threshold, 160_000);
});

test("按模型的值：记着是我们写的就是 ours，否则是用户的", () => {
  const settings = withOverride({}, KEY, 744_000);
  assert.equal(currentThreshold(settings, KEY, 1_000_000, { value: 744_000 }).source, "ours");
  assert.equal(currentThreshold(settings, KEY, 1_000_000, null).source, "user");
  assert.equal(currentThreshold(settings, KEY, 1_000_000, { value: 1 }).source, "user");
  assert.equal(currentThreshold(settings, KEY, 1_000_000, null).threshold, 256_000);
});

test("写入不改原对象，别的设置原样保留", () => {
  const settings = { defaultModel: "x", compaction: { enabled: true, modelOverrides: { other: { keepRecentTokens: 1 } } } };
  const next = withOverride(settings, KEY, 100);
  assert.equal(settings.compaction.modelOverrides[KEY], undefined);
  assert.equal(next.defaultModel, "x");
  assert.equal(next.compaction.enabled, true);
  assert.deepEqual(next.compaction.modelOverrides.other, { keepRecentTokens: 1 });
  assert.equal(next.compaction.modelOverrides[KEY].reserveTokens, 100);
});

test("撤销删掉我们加的，删空的对象一并删", () => {
  assert.deepEqual(withoutOverride(withOverride({ defaultModel: "x" }, KEY, 100), KEY), { defaultModel: "x" });
  const kept = withoutOverride(
    { compaction: { enabled: true, modelOverrides: { [KEY]: { reserveTokens: 100, keepRecentTokens: 5 } } } },
    KEY,
  );
  assert.deepEqual(kept, { compaction: { enabled: true, modelOverrides: { [KEY]: { keepRecentTokens: 5 } } } });
});

test("自动压缩开关", () => {
  assert.equal(autoCompactionEnabled({}), true);
  assert.equal(autoCompactionEnabled({ compaction: { enabled: false } }), false);
});
