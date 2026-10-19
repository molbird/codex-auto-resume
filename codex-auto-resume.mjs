import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectDesktop } from './lib/desktop-client.mjs';
import { readLocalThreads } from './lib/thread-index.mjs';
import { Monitor, FatalMonitorError } from './lib/monitor.mjs';
import { atomicJson, readState, processAlive, acquireLock, createLogger } from './lib/storage.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(root, 'runtime');
const lockFile = path.join(runtime, 'monitor.lock');
const stateFile = path.join(runtime, 'state.json');
const stopFile = path.join(runtime, 'stop.request');
const statusFile = path.join(runtime, 'status.json');

function loadConfig() {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  for (const [name, min, max] of [
    ['pollSeconds', 5, 3600], ['resetGraceSeconds', 0, 300], ['maxConcurrentResumes', 1, 8],
    ['retryCooldownSeconds', 30, 3600], ['refreshUnchangedMinutes', 1, 1440],
  ]) {
    if (!Number.isInteger(config[name]) || config[name] < min || config[name] > max) {
      throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
    }
  }
  if (!config.controllerThreadId || typeof config.controllerThreadId !== 'string') throw new Error('缺少 controllerThreadId');
  if (!Array.isArray(config.excludeThreadIds) || config.excludeThreadIds.some(id => typeof id !== 'string')) throw new Error('excludeThreadIds 必须是字符串数组');
  if (typeof config.resumePrompt !== 'string' || !config.resumePrompt.trim()) throw new Error('resumePrompt 不能为空');
  return config;
}

function status() {
  let lock, latest;
  try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { /* Not running. */ }
  try { latest = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { /* Not scanned. */ }
  return { running: processAlive(lock?.pid), pid: lock?.pid ?? null,
    startedAt: lock?.startedAt ?? null, ...(latest || {}) };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const actions = ['--watch', '--check', '--stop', '--status', '--help'].filter(flag => args.has(flag));
  if (actions.length !== 1 || [...args].some(arg => ![...actions, '--quiet'].includes(arg))) {
    throw new Error('请选择一个操作：--watch / --check / --status / --stop / --help');
  }
  if (args.has('--help')) {
    console.log('node codex-auto-resume.mjs --watch   后台监控使用 --quiet\nnode codex-auto-resume.mjs --check   只读检查，不发送消息\nnode codex-auto-resume.mjs --status  查看状态\nnode codex-auto-resume.mjs --stop    请求安全停止');
    return;
  }
  if (args.has('--status')) { console.log(JSON.stringify(status(), null, 2)); return; }
  if (args.has('--stop')) {
    fs.mkdirSync(runtime, { recursive: true });
    if (!status().running) { console.log('监控没有运行。'); return; }
    fs.writeFileSync(stopFile, new Date().toISOString());
    console.log('已请求停止监控；当前只读请求结束后退出，通常不超过 30 秒。');
    return;
  }

  const config = loadConfig();
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const listThreads = () => readLocalThreads(codexHome);
  if (args.has('--check')) {
    const client = await connectDesktop(config.controllerThreadId);
    try {
      const monitor = new Monitor({ client, config, state: readState(stateFile), listThreads,
        log: (level, text) => console.error(`[${level}] ${text}`) });
      const result = await monitor.tick({ dryRun: true });
      console.log(JSON.stringify({ ...result, message: '只读检查完成，未发送任何续跑消息' }, null, 2));
    } finally { client.close(); }
    return;
  }

  fs.mkdirSync(runtime, { recursive: true });
  const unlock = acquireLock(lockFile);
  const log = createLogger(runtime, args.has('--quiet'));
  let client, stopping = false, monitor, lastSummary = '', lastHeartbeat = 0;
  let report = {};
  const shouldStop = () => stopping || fs.existsSync(stopFile);
  const signalStop = () => { stopping = true; };
  process.on('SIGINT', signalStop);
  process.on('SIGTERM', signalStop);
  try {
    const state = readState(stateFile);
    if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile);
    atomicJson(statusFile, { phase: 'starting', checkedAt: null });
    log('INFO', `监控启动，PID ${process.pid}；每 ${config.pollSeconds} 秒检查所有未归档本地聊天`);
    let consecutiveErrors = 0;
    while (!shouldStop()) {
      try {
        if (!client || client.closed) {
          client?.close();
          client = await connectDesktop(config.controllerThreadId);
          monitor = new Monitor({ client, config, state, listThreads, log,
            save: value => atomicJson(stateFile, value), stopping: shouldStop });
          log('INFO', '已连接 Codex 桌面端');
        }
        report = await monitor.tick();
        consecutiveErrors = 0;
        const summary = `本地聊天 ${report.localThreads}，额度停止 ${report.quotaStoppedThreads}，待续跑 ${report.pendingThreads}；${report.reason}`;
        if (summary !== lastSummary || Date.now() - lastHeartbeat > 10 * 60_000) {
          log('INFO', summary + (report.resetAt ? `；复查时间 ${report.resetAt}` : ''));
          lastSummary = summary;
          lastHeartbeat = Date.now();
        }
        atomicJson(statusFile, { ...report, phase: 'watching', lastError: null });
      } catch (error) {
        log('ERROR', error.message);
        if (error instanceof FatalMonitorError) throw error;
        consecutiveErrors++;
        atomicJson(statusFile, { ...report, phase: 'reconnecting', lastError: error.message,
          lastErrorAt: new Date().toISOString() });
        client?.close();
        client = null;
        // Connection failures do not send any messages. Retry when the app returns.
      }
      const backoff = Math.min(300, config.pollSeconds * Math.max(1, consecutiveErrors));
      let waitMs = backoff * 1000;
      if (state.waitUntil > Date.now()) waitMs = Math.min(waitMs, state.waitUntil - Date.now());
      const next = Date.now() + waitMs;
      while (!shouldStop() && Date.now() < next) await sleep(Math.min(1000, next - Date.now()));
    }
    log('INFO', '监控已安全停止');
  } finally {
    client?.close();
    atomicJson(statusFile, { ...report, phase: 'stopped', stoppedAt: new Date().toISOString() });
    unlock();
    process.off('SIGINT', signalStop);
    process.off('SIGTERM', signalStop);
  }
}

main().catch(error => { console.error(`错误：${error.message}`); process.exitCode = 1; });
