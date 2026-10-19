import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readLocalThreads } from '../lib/thread-index.mjs';
import { atomicJson, readState, acquireLock } from '../lib/storage.mjs';

function directory(t) {
  const parent = fileURLToPath(new URL('../.scratch/tests/', import.meta.url));
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'codex-resume-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(parent));
    assert.match(path.basename(dir), /^codex-resume-test-/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('enumerates more than 50 local chats, excluding archived and subagents', t => {
  const dir = directory(t);
  const db = new DatabaseSync(path.join(dir, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, title TEXT, name TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at INTEGER, updated_at_ms INTEGER)');
  const insert = db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 101; i++) insert.run(`chat-${i}`, 'prompt', `title-${i}`, 'D:\\test', 'vscode', 0, 10, 10_005);
  insert.run('archived', 'prompt', null, 'D:\\test', 'vscode', 1, 10, 10_005);
  insert.run('guardian', 'prompt', null, 'D:\\test', '{"subagent":{"other":"guardian"}}', 0, 10, 10_005);
  db.close();
  const threads = readLocalThreads(dir);
  assert.equal(threads.length, 101);
  assert.equal(threads[0].title, 'title-0');
  assert.equal(threads[0].revision, 10_005);
});

test('state is saved atomically, and corruption fails closed', t => {
  const file = path.join(directory(t), 'state.json');
  const state = readState(file);
  atomicJson(file, state);
  assert.deepEqual(readState(file), state);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => readState(file), /损坏/);
});

test('only one monitor can acquire the lock', t => {
  const file = path.join(directory(t), 'monitor.lock');
  const release = acquireLock(file);
  assert.throws(() => acquireLock(file), /已在运行/);
  release();
  acquireLock(file)();
});
