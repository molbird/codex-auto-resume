import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function readState(file) {
  if (!fs.existsSync(file)) return { version: 1, accountId: null, waitUntil: 0, attempts: {} };
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('续跑记录损坏；为避免重复发送，已停止。请保留 runtime/state.json 排查'); }
  if (state.version !== 1 || !state.attempts || typeof state.attempts !== 'object' || Array.isArray(state.attempts)) {
    throw new Error('续跑记录格式不受支持，已停止以避免重复发送');
  }
  for (const attempt of Object.values(state.attempts)) {
    if (!attempt || typeof attempt.threadId !== 'string' || !Number.isFinite(attempt.attemptedAt)
      || !['sending', 'sent', 'uncertain'].includes(attempt.status)) {
      throw new Error('续跑记录包含无效条目，已停止以避免重复发送');
    }
  }
  return state;
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export function acquireLock(file) {
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }), { flag: 'wx' });
      return () => {
        const current = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (current.token === token) fs.unlinkSync(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (processAlive(current.pid)) throw new Error(`监控已在运行，PID ${current.pid}`);
      fs.unlinkSync(file);
    }
  }
  throw new Error('无法取得监控锁');
}

export function createLogger(directory, quiet = false) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'monitor.log');
  return (level, message) => {
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) {
      const previous = `${file}.1`;
      if (fs.existsSync(previous)) fs.unlinkSync(previous);
      fs.renameSync(file, previous);
    }
    const time = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const line = `${time} [${level}] ${message.replace(/[\r\n]+/g, ' ')}\n`;
    fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
    if (!quiet) process.stdout.write(line);
  };
}
