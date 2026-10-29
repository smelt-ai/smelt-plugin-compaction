// 引擎入口。插件的脚本跑在 UI 线程上，几百 MB 的会话文件不能在那里读，所以由插件起一个
// 子进程跑这里：smelt 自带的 smelt-pi 是 Bun 编出来的，带上 `BUN_BE_BUN=1` 就是一个 Bun。
//
//   BUN_BE_BUN=1 ~/.smelt/bin/smelt-pi engine/cli.js analyze --home ~ --smelt-pi ~/.smelt/bin/smelt-pi
//   BUN_BE_BUN=1 ~/.smelt/bin/smelt-pi engine/cli.js apply --home ~ --model p/m --threshold 256000 --window 1000000
//   BUN_BE_BUN=1 ~/.smelt/bin/smelt-pi engine/cli.js undo --home ~ --model p/m
//
// 子进程的环境变量是空的，主目录这些都从参数传。stdout 每行一个 JSON：
// `{ type: "progress" | "result" | "applied" | "undone" | "error", ... }`。

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { advise, weightsFor } from "./tune.js";
import { piReader, weightsFromCosts } from "./pi.js";
import { parseListModels, modelsJsonWindows, mergeWindows } from "./windows.js";
import {
  DEFAULT_RESERVE,
  autoCompactionEnabled,
  currentThreshold,
  overrideOf,
  withOverride,
  withoutOverride,
} from "./pi-settings.js";
import { openStore } from "./store.js";

const PLUGIN_ID = "com.smelt.compaction-tune";
const AGENT = "pi";
/** 候选压缩点从这里起，按这个步长试。 */
const MIN_THRESHOLD = 50_000;
const STEP = 10_000;
/** smelt-pi 和守护的握手版本。猜错了它会在 stderr 说自己是几，照着再跑一次。 */
const PROTOCOL_GUESS = "1";
const LIST_MODELS_TIMEOUT_MS = 60_000;
/** Pi 的设置锁（proper-lockfile）：锁目录超过这么久没更新就算死锁。 */
const LOCK_STALE_MS = 10_000;
const LOCK_ATTEMPTS = 50;
const LOCK_RETRY_MS = 20;

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith("--") || rest[i + 1] === undefined) throw new Error(`参数不对：${rest[i]}`);
    flags[rest[i].slice(2)] = rest[i + 1];
  }
  if (!flags.home) throw new Error("缺少 --home");
  return { command, flags };
}

function paths(home) {
  const agentDir = join(home, ".pi", "agent");
  return {
    sessions: join(agentDir, "sessions"),
    settings: join(agentDir, "settings.json"),
    models: join(agentDir, "models.json"),
    store: join(home, ".smelt", "plugin-data", PLUGIN_ID, "state.sqlite3"),
  };
}

async function readJson(path, fallback) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} 不是合法的 JSON：${error.message}`);
  }
}

async function sessionFiles(dir) {
  let names;
  try {
    names = await readdir(dir, { recursive: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return names.filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name)).sort();
}

/** 流式按行读，不把整个文件放进内存。 */
async function readCalls(path) {
  const read = piReader(path);
  const calls = [];
  const decoder = new TextDecoder();
  let rest = "";
  const take = (line) => {
    const call = read(line);
    if (call) calls.push(call);
  };
  for await (const chunk of Bun.file(path).stream()) {
    rest += decoder.decode(chunk, { stream: true });
    let start = 0;
    let end;
    while ((end = rest.indexOf("\n", start)) !== -1) {
      take(rest.slice(start, end));
      start = end + 1;
    }
    rest = rest.slice(start);
  }
  rest += decoder.decode();
  if (rest) take(rest);
  return calls;
}

/** 只重读大小或修改时间变了的会话文件。 */
async function scan(store, dir) {
  const files = await sessionFiles(dir);
  let read = 0;
  emit({ type: "progress", phase: "scan", done: 0, total: files.length });
  for (const [index, path] of files.entries()) {
    const info = await stat(path);
    const size = info.size;
    const mtimeMs = Math.trunc(info.mtimeMs);
    const cached = store.fileState(path);
    if (!cached || cached.size !== size || cached.mtimeMs !== mtimeMs) {
      store.replaceFile(path, AGENT, size, mtimeMs, await readCalls(path));
      read += 1;
    }
    emit({ type: "progress", phase: "scan", done: index + 1, total: files.length });
  }
  store.forgetMissing(AGENT, new Set(files));
  return { files: files.length, read };
}

async function runListModels(home, smeltPi, protocol) {
  const child = Bun.spawn([smeltPi, "--list-models"], {
    env: { HOME: home, USERPROFILE: home, SMELT_PI_PROTOCOL: protocol },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: LIST_MODELS_TIMEOUT_MS,
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: await child.exited, out, err };
}

/** Pi 自己认的各模型窗口。 */
async function piWindows(home, smeltPi, modelsPath) {
  const exact = modelsJsonWindows(await readJson(modelsPath, {}));
  let result = await runListModels(home, smeltPi, PROTOCOL_GUESS);
  const own = /smelt-pi 的协议是 (\d+)/.exec(result.err);
  if (result.code !== 0 && own) result = await runListModels(home, smeltPi, own[1]);
  if (result.code !== 0) {
    return { windows: exact, error: `smelt-pi --list-models 失败：${result.err.trim() || `退出码 ${result.code}`}` };
  }
  return { windows: mergeWindows(parseListModels(result.out), exact), error: null };
}

function groupByModel(calls) {
  const by = new Map();
  for (const call of calls) {
    const list = by.get(call.model);
    if (list) list.push(call);
    else by.set(call.model, [call]);
  }
  return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
}

async function analyze(flags) {
  const p = paths(flags.home);
  const store = openStore(p.store);
  try {
    const scanned = await scan(store, p.sessions);
    emit({ type: "progress", phase: "windows" });
    const { windows, error: windowsError } = flags["smelt-pi"]
      ? await piWindows(flags.home, flags["smelt-pi"], p.models)
      : { windows: modelsJsonWindows(await readJson(p.models, {})), error: "没有给 --smelt-pi" };
    const settings = await readJson(p.settings, {});
    const applied = store.appliedAll(AGENT);
    emit({ type: "progress", phase: "replay" });
    const models = groupByModel(store.calls(AGENT)).map(([model, calls]) => {
      const weights = weightsFromCosts(calls, weightsFor(model));
      let row = applied.get(model) ?? null;
      // 记着写过、文件里却不是那个值了：用户自己改过，从此不算我们的。
      if (row && overrideOf(settings, model) !== row.value) {
        store.forgetApplied(AGENT, model);
        row = null;
      }
      const win = windows.get(model);
      if (!win) {
        return {
          model,
          calls: calls.length,
          window: null,
          current: null,
          advice: advise(calls, { min: MIN_THRESHOLD, max: 1_000_000, step: STEP, reserve: 0, current: 0, window: 0, weights }),
        };
      }
      const current = currentThreshold(settings, model, win.window, row);
      // 压缩点最高到 窗口 − Pi 默认的留空：再高，最后一次回复可能装不下。
      const top = win.window - DEFAULT_RESERVE;
      return {
        model,
        calls: calls.length,
        window: win.window,
        windowApprox: win.approx,
        current,
        appliedAt: row?.appliedAt ?? null,
        advice: advise(calls, {
          min: MIN_THRESHOLD,
          max: top,
          step: STEP,
          reserve: 0,
          current: current.threshold,
          window: top,
          weights,
        }),
      };
    });
    emit({
      type: "result",
      agent: AGENT,
      generatedAt: Date.now(),
      files: scanned.files,
      filesRead: scanned.read,
      autoCompaction: autoCompactionEnabled(settings),
      settingsPath: p.settings,
      windowsError,
      models,
    });
  } finally {
    store.close();
  }
}

/** 和 Pi 用同一把锁（proper-lockfile 的 `settings.json.lock` 目录）改它的设置。 */
async function withSettingsLock(path, fn) {
  const lock = `${path}.lock`;
  for (let attempt = 1; ; attempt++) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const info = await stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (attempt >= LOCK_ATTEMPTS) throw new Error("Pi 正在写 settings.json，稍后再试");
      // 轮询例外：锁是 Pi 用 mkdir 建的目录，没有释放通知；周期 20ms，上限 50 次（约 1 秒）。
      await Bun.sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

function integer(flags, name) {
  const value = Number(flags[name]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} 要是正整数`);
  return value;
}

async function apply(flags) {
  const model = flags.model;
  if (!model) throw new Error("缺少 --model");
  const threshold = integer(flags, "threshold");
  const window = integer(flags, "window");
  const reserve = window - threshold;
  if (reserve < DEFAULT_RESERVE) throw new Error(`压缩点太靠近窗口：至少要留 ${DEFAULT_RESERVE}`);
  const p = paths(flags.home);
  const store = openStore(p.store);
  try {
    await withSettingsLock(p.settings, async () => {
      const settings = await readJson(p.settings, {});
      const existing = overrideOf(settings, model);
      const row = store.applied(AGENT, model);
      if (existing !== null && existing !== row?.value) {
        throw new Error(`settings.json 里已经给 ${model} 设了 reserveTokens = ${existing}，插件不改你自己设的值`);
      }
      await writeJsonAtomic(p.settings, withOverride(settings, model, reserve));
      store.setApplied(AGENT, model, reserve);
    });
    emit({ type: "applied", model, threshold, reserve });
  } finally {
    store.close();
  }
}

async function undo(flags) {
  const model = flags.model;
  if (!model) throw new Error("缺少 --model");
  const p = paths(flags.home);
  const store = openStore(p.store);
  try {
    const row = store.applied(AGENT, model);
    let restored = false;
    if (row) {
      await withSettingsLock(p.settings, async () => {
        const settings = await readJson(p.settings, {});
        // 文件里已经不是我们写的值了，就是用户自己改过，只忘掉记录，不动文件。
        if (overrideOf(settings, model) === row.value) {
          await writeJsonAtomic(p.settings, withoutOverride(settings, model));
          restored = true;
        }
      });
      store.forgetApplied(AGENT, model);
    }
    emit({ type: "undone", model, restored });
  } finally {
    store.close();
  }
}

const COMMANDS = { analyze, apply, undo };

try {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const run = COMMANDS[command];
  if (!run) throw new Error(`不认识的命令：${command ?? "（没给）"}`);
  await run(flags);
} catch (error) {
  emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
