// 引擎入口。插件的脚本跑在 UI 线程上，几百 MB 的会话文件不能在那里读，所以由插件起一个
// 子进程跑这里：smelt 自带的 smelt-pi 是 Bun 编出来的，带上 `BUN_BE_BUN=1` 就是一个 Bun。
//
//   BUN_BE_BUN=1 ~/.smelt/bin/smelt-pi engine/cli.js analyze --home ~ --smelt-pi ~/.smelt/bin/smelt-pi
//   BUN_BE_BUN=1 ~/.smelt/bin/smelt-pi engine/cli.js apply --home ~ --agent pi --model p/m --value 256000 --window 1000000
//   BUN_BE_BUN=1 ~/.smelt/bin/smelt-pi engine/cli.js undo --home ~ --agent pi --model p/m
//
// 子进程的环境变量是空的，主目录这些都从参数传；插件看得到的 CLAUDE_CODE_AUTO_COMPACT_WINDOW
// 用 `--claude-env` 传进来。stdout 每行一个 JSON：
// `{ type: "progress" | "result" | "applied" | "undone" | "error", ... }`。

import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { advise, dedupe, median } from "./tune.js";
import { AGENTS, agentById } from "./agents.js";
import { CLAUDE_ENV } from "./claude.js";
import { openStore } from "./store.js";

const PLUGIN_ID = "com.smelt.compaction-tune";
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

function storePath(home) {
  return join(home, ".smelt", "plugin-data", PLUGIN_ID, "state.sqlite3");
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
async function readCalls(path, reader) {
  const read = reader(path);
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
async function scan(store, agent, home) {
  const files = await sessionFiles(agent.sessionsDir(home));
  let read = 0;
  emit({ type: "progress", phase: "scan", agent: agent.label, done: 0, total: files.length });
  for (const [index, path] of files.entries()) {
    const info = await stat(path);
    const size = info.size;
    const mtimeMs = Math.trunc(info.mtimeMs);
    const cached = store.fileState(path);
    if (!cached || cached.size !== size || cached.mtimeMs !== mtimeMs) {
      store.replaceFile(path, agent.id, size, mtimeMs, await readCalls(path, agent.reader));
      read += 1;
    }
    emit({ type: "progress", phase: "scan", agent: agent.label, done: index + 1, total: files.length });
  }
  store.forgetMissing(agent.id, new Set(files));
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

/** `smelt-pi --list-models` 的输出；失败时 `{ error }`。 */
async function listPiModels(home, smeltPi) {
  if (!smeltPi) return { error: "没有给 --smelt-pi" };
  let result = await runListModels(home, smeltPi, PROTOCOL_GUESS);
  const own = /smelt-pi 的协议是 (\d+)/.exec(result.err);
  if (result.code !== 0 && own) result = await runListModels(home, smeltPi, own[1]);
  if (result.code !== 0) {
    return { error: `smelt-pi --list-models 失败：${result.err.trim() || `退出码 ${result.code}`}` };
  }
  return { text: result.out };
}

function groupByModel(calls) {
  const by = new Map();
  for (const call of calls) {
    const list = by.get(call.model);
    if (list) list.push(call);
    else by.set(call.model, [call]);
  }
  return new Map([...by.entries()].sort((a, b) => b[1].length - a[1].length));
}

async function analyzeAgent(store, agent, ctx) {
  const scanned = await scan(store, agent, ctx.home);
  const calls = dedupe(store.calls(agent.id));
  // 中途换过模型的对话不知道开头多长，拿这个 agent 所有对话的开头来补。
  const agentBase = median(calls.filter((call) => call.seq === 0).map((call) => call.prompt));
  const byModel = groupByModel(calls);
  if (byModel.size === 0) {
    return { agent: agent.id, label: agent.label, files: scanned.files, filesRead: scanned.read, models: [] };
  }
  emit({ type: "progress", phase: "windows", agent: agent.label });
  const { windows, error: windowsError } = await agent.windows(ctx, byModel);
  const settingsPath = agent.settingsPath(ctx.home);
  const settings = await readJson(settingsPath, {});
  const applied = store.appliedAll(agent.id);
  emit({ type: "progress", phase: "replay", agent: agent.label });
  const models = [...byModel].map(([model, calls]) => {
    const weights = agent.weights(calls, model);
    let row = applied.get(model) ?? null;
    // 记着写过、文件里却不是那个值了：用户自己改过，从此不算我们的。
    if (row && agent.existing(settings, model) !== row.value) {
      store.forgetApplied(agent.id, model);
      row = null;
    }
    const win = windows.get(model);
    if (!win) {
      return {
        model,
        calls: calls.length,
        window: null,
        reserve: agent.reserve,
        current: null,
        advice: advise(calls, {
          min: 50_000,
          max: 1_000_000,
          step: 10_000,
          reserve: agent.reserve,
          current: 0,
          window: 0,
          weights,
          base: agentBase,
        }),
      };
    }
    const current = agent.current(settings, model, win.window, row, ctx);
    return {
      model,
      calls: calls.length,
      window: win.window,
      windowApprox: win.approx,
      reserve: agent.reserve,
      current,
      appliedAt: row?.appliedAt ?? null,
      advice: advise(calls, { ...agent.tune(win.window), current: current.value, weights, base: agentBase }),
    };
  });
  return {
    agent: agent.id,
    label: agent.label,
    files: scanned.files,
    filesRead: scanned.read,
    autoCompaction: agent.enabled(settings),
    settingsPath,
    windowsError,
    models,
  };
}

async function analyze(flags) {
  const store = openStore(storePath(flags.home));
  const ctx = {
    home: flags.home,
    env: flags["claude-env"] ? { [CLAUDE_ENV]: flags["claude-env"] } : {},
    readJson,
    listPiModels: () => listPiModels(flags.home, flags["smelt-pi"]),
  };
  try {
    const agents = [];
    for (const agent of AGENTS) agents.push(await analyzeAgent(store, agent, ctx));
    emit({ type: "result", generatedAt: Date.now(), agents });
  } finally {
    store.close();
  }
}

/** 和 Pi 用同一把锁（proper-lockfile 的 `settings.json.lock` 目录）改它的设置。 */
async function withPiLock(path, fn) {
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

/** 换掉文件内容。设置文件是软链时写到它指向的文件，不把软链换成普通文件。 */
async function writeJsonAtomic(path, value) {
  const target = await realpath(path).catch(() => path);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, target);
}

/** 读、改、写 agent 的设置文件，要锁就锁上。 */
async function editSettings(agent, home, edit) {
  const path = agent.settingsPath(home);
  const run = async () => {
    const settings = await readJson(path, {});
    const next = await edit(settings);
    if (next !== null) await writeJsonAtomic(path, next);
  };
  if (agent.piLock) await withPiLock(path, run);
  else await run();
}

function integer(flags, name) {
  const value = Number(flags[name]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} 要是正整数`);
  return value;
}

function target(flags) {
  if (!flags.model) throw new Error("缺少 --model");
  return { agent: agentById(flags.agent ?? ""), model: flags.model };
}

async function apply(flags) {
  const { agent, model } = target(flags);
  const value = integer(flags, "value");
  const window = integer(flags, "window");
  const store = openStore(storePath(flags.home));
  try {
    let stored = null;
    await editSettings(agent, flags.home, (settings) => {
      const existing = agent.existing(settings, model);
      const row = store.applied(agent.id, model);
      if (existing !== null && existing !== row?.value) {
        throw new Error(`${agent.settingsPath(flags.home)} 里已经给 ${model} 设了压缩点，插件不改你自己设的值`);
      }
      const next = agent.apply(settings, model, value, window);
      stored = next.stored;
      return next.settings;
    });
    // 文件写成了才记账：写失败时不能留一条「我们写过」的记录。
    store.setApplied(agent.id, model, stored);
    emit({ type: "applied", agent: agent.id, model, value });
  } finally {
    store.close();
  }
}

async function undo(flags) {
  const { agent, model } = target(flags);
  const store = openStore(storePath(flags.home));
  try {
    const row = store.applied(agent.id, model);
    let restored = false;
    if (row) {
      await editSettings(agent, flags.home, (settings) => {
        // 文件里已经不是我们写的值了，就是用户自己改过，只忘掉记录，不动文件。
        if (agent.existing(settings, model) !== row.value) return null;
        restored = true;
        return agent.undo(settings, model);
      });
      store.forgetApplied(agent.id, model);
    }
    emit({ type: "undone", agent: agent.id, model, restored });
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
