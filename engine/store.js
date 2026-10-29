// 插件自己的库：`~/.smelt/plugin-data/com.smelt.compaction-tune/state.sqlite3`。
// - `files` / `calls`：每个会话文件读出来的调用。文件大小和修改时间没变就不再读，
//   只是会话文件的缓存，删了会重新读出来。
// - `applied`：本插件往 agent 设置里写过什么，撤销和判断「是不是我们写的」靠它。
//
// 只在 Bun 里跑（`bun:sqlite`）。

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = 1;

const CALL_COLUMNS = [
  "time",
  "model",
  "prompt",
  "out",
  "wrote",
  "wrote1h",
  "cut",
  "compact_ms",
  "input",
  "cache_read",
  "cost_input",
  "cost_output",
  "cost_cache_read",
  "cost_cache_write",
];

export function openStore(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  const version = db.query("PRAGMA user_version").get().user_version;
  if (version > SCHEMA) {
    db.close();
    throw new Error(`插件数据库是新版本插件建的（版本 ${version}），请更新插件`);
  }
  if (version < 1) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE files (
          path TEXT PRIMARY KEY,
          agent TEXT NOT NULL,
          size INTEGER NOT NULL,
          mtime_ms INTEGER NOT NULL
        );
        CREATE TABLE calls (
          path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          time INTEGER NOT NULL,
          model TEXT NOT NULL,
          prompt INTEGER NOT NULL,
          out INTEGER NOT NULL,
          wrote INTEGER NOT NULL,
          wrote1h INTEGER NOT NULL,
          cut INTEGER NOT NULL,
          compact_ms INTEGER NOT NULL,
          input INTEGER NOT NULL,
          cache_read INTEGER NOT NULL,
          cost_input REAL NOT NULL,
          cost_output REAL NOT NULL,
          cost_cache_read REAL NOT NULL,
          cost_cache_write REAL NOT NULL,
          PRIMARY KEY (path, seq)
        );
        CREATE TABLE applied (
          agent TEXT NOT NULL,
          model TEXT NOT NULL,
          value INTEGER NOT NULL,
          applied_at INTEGER NOT NULL,
          PRIMARY KEY (agent, model)
        );
        PRAGMA user_version = 1;
      `);
    })();
  }
  db.exec("PRAGMA foreign_keys = ON");

  const fileState = db.query("SELECT size, mtime_ms FROM files WHERE path = ?");
  const upsertFile = db.query(
    "INSERT INTO files (path, agent, size, mtime_ms) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(path) DO UPDATE SET agent = excluded.agent, size = excluded.size, mtime_ms = excluded.mtime_ms",
  );
  const deleteCalls = db.query("DELETE FROM calls WHERE path = ?");
  const insertCall = db.query(
    `INSERT INTO calls (path, seq, ${CALL_COLUMNS.join(", ")}) VALUES (${Array(CALL_COLUMNS.length + 2)
      .fill("?")
      .join(", ")})`,
  );
  const deleteFile = db.query("DELETE FROM files WHERE path = ?");
  const agentFiles = db.query("SELECT path FROM files WHERE agent = ?");
  const agentCalls = db.query(
    `SELECT calls.path, ${CALL_COLUMNS.map((c) => `calls.${c}`).join(", ")} FROM calls ` +
      "JOIN files ON files.path = calls.path WHERE files.agent = ? ORDER BY calls.path, calls.seq",
  );
  const appliedOf = db.query("SELECT value, applied_at FROM applied WHERE agent = ? AND model = ?");
  const appliedAll = db.query("SELECT model, value, applied_at FROM applied WHERE agent = ?");
  const upsertApplied = db.query(
    "INSERT INTO applied (agent, model, value, applied_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(agent, model) DO UPDATE SET value = excluded.value, applied_at = excluded.applied_at",
  );
  const deleteApplied = db.query("DELETE FROM applied WHERE agent = ? AND model = ?");

  return {
    /** 上次读这个文件时它多大、什么时候改的；没读过是 null。 */
    fileState(path) {
      const row = fileState.get(path);
      return row ? { size: row.size, mtimeMs: row.mtime_ms } : null;
    },

    /** 换上这个文件新读出来的调用。 */
    replaceFile: db.transaction((path, agent, size, mtimeMs, calls) => {
      upsertFile.run(path, agent, size, mtimeMs);
      deleteCalls.run(path);
      calls.forEach((call, seq) => {
        insertCall.run(
          path,
          seq,
          call.time,
          call.model,
          call.prompt,
          call.out,
          call.wrote,
          call.wrote1h,
          call.cut ? 1 : 0,
          call.compactMs,
          call.input,
          call.cacheRead,
          call.costInput,
          call.costOutput,
          call.costCacheRead,
          call.costCacheWrite,
        );
      });
    }),

    /** 这个 agent 的会话文件里已经不在的，从缓存里删掉。 */
    forgetMissing: db.transaction((agent, present) => {
      for (const { path } of agentFiles.all(agent)) {
        if (!present.has(path)) deleteFile.run(path);
      }
    }),

    /** 这个 agent 缓存里的全部调用，形状同 pi.js 读出来的。 */
    calls(agent) {
      return agentCalls.all(agent).map((row) => ({
        stream: row.path,
        time: row.time,
        model: row.model,
        prompt: row.prompt,
        out: row.out,
        wrote: row.wrote,
        wrote1h: row.wrote1h,
        cut: row.cut === 1,
        compactMs: row.compact_ms,
        input: row.input,
        cacheRead: row.cache_read,
        costInput: row.cost_input,
        costOutput: row.cost_output,
        costCacheRead: row.cost_cache_read,
        costCacheWrite: row.cost_cache_write,
      }));
    },

    applied(agent, model) {
      const row = appliedOf.get(agent, model);
      return row ? { value: row.value, appliedAt: row.applied_at } : null;
    },

    appliedAll(agent) {
      return new Map(
        appliedAll.all(agent).map((row) => [row.model, { value: row.value, appliedAt: row.applied_at }]),
      );
    },

    setApplied(agent, model, value) {
      upsertApplied.run(agent, model, value, Date.now());
    },

    forgetApplied(agent, model) {
      deleteApplied.run(agent, model);
    },

    close() {
      db.close();
    },
  };
}
