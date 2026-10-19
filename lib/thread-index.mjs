import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function isRootSource(source) {
  try {
    const parsed = JSON.parse(source);
    if (typeof parsed === 'object' && parsed !== null) {
      return !Object.keys(parsed).some(key => /sub.?agent/i.test(key));
    }
    source = parsed;
  } catch { /* Most root sources are plain text, for example vscode. */ }
  return typeof source === 'string' && !/sub.?agent/i.test(source);
}

export function readLocalThreads(codexHome) {
  const databases = fs.readdirSync(codexHome)
    .map(name => ({ name, version: Number(/^state_(\d+)\.sqlite$/.exec(name)?.[1] || 0) }))
    .filter(entry => entry.version > 0).sort((a, b) => b.version - a.version);
  if (!databases.length) throw new Error('未找到 Codex 本地聊天索引 state_*.sqlite');
  const db = new DatabaseSync(path.join(codexHome, databases[0].name), { readOnly: true });
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => row.name));
    for (const column of ['id', 'title', 'cwd', 'updated_at', 'archived', 'source']) {
      if (!columns.has(column)) throw new Error(`聊天索引结构已变化，缺少 ${column}`);
    }
    const revision = columns.has('updated_at_ms') ? 'COALESCE(updated_at_ms, updated_at * 1000)' : 'updated_at * 1000';
    const title = columns.has('name') ? 'COALESCE(name, title)' : 'title';
    return db.prepare(`SELECT id, ${title} AS title, cwd, source, ${revision} AS revision
      FROM threads WHERE archived = 0 ORDER BY updated_at DESC`).all()
      .filter(row => isRootSource(row.source));
  } finally { db.close(); }
}
