// The current Windows desktop app exposes its own tools through a local pipe.
// This is an internal interface, so discover and validate it on every reconnect.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const REQUIRED_TOOLS = ['get_usage_limits', 'read_thread', 'send_message_to_thread'];

export class DesktopClient {
  constructor(socket, controllerThreadId, timeoutMs = 30_000) {
    this.socket = socket;
    this.controllerThreadId = controllerThreadId;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    socket.on('data', chunk => this.receive(chunk));
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(new Error('Codex 桌面端连接已关闭')));
  }

  static async connect(pipePath, controllerThreadId, timeoutMs = 30_000) {
    const socket = net.createConnection(pipePath);
    const client = new DesktopClient(socket, controllerThreadId, timeoutMs);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('连接本地管道超时')), 2000);
        const done = error => {
          clearTimeout(timer);
          socket.off('connect', connected);
          socket.off('error', done);
          error ? reject(error) : resolve();
        };
        const connected = () => done();
        socket.once('connect', connected);
        socket.once('error', done);
      });
      const catalog = await client.request('tools/list', { threadStartKind: 'all' }, 2000);
      const names = new Set(catalog.tools?.filter(t => t.namespace === 'codex_app').map(t => t.name));
      if (!REQUIRED_TOOLS.every(name => names.has(name))) {
        throw new Error('该管道没有所需的 Codex 桌面工具');
      }
      client.pipePath = pipePath;
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(new Error('Codex 桌面端未连接'));
    const id = this.nextId++;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    if (body.length > MAX_FRAME_BYTES) return Promise.reject(new Error('请求超过管道大小限制'));
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32LE(body.length);
    body.copy(frame, 4);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时；结果可能尚未返回`));
        // Do not reuse a connection with an ambiguous outstanding operation.
        this.close();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(frame, error => { if (error) this.fail(error); });
    });
  }

  receive(chunk) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE(0);
        if (size > MAX_FRAME_BYTES) throw new Error('桌面端返回的消息超过 8 MiB');
        if (this.buffer.length < size + 4) return;
        const message = JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8'));
        this.buffer = this.buffer.subarray(size + 4);
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
    } catch (error) {
      this.fail(error);
      this.socket.destroy();
    }
  }

  async call(tool, args = {}) {
    const response = await this.request('tools/call', {
      namespace: 'codex_app', tool, arguments: args,
      callerSource: 'codex', hostId: 'local', threadId: this.controllerThreadId,
      turnId: `quota-monitor-${randomUUID()}`, callId: `quota-monitor-${randomUUID()}`,
    });
    const text = response?.contentItems?.filter(i => i.type === 'inputText').map(i => i.text).join('\n');
    if (response?.success !== true) throw new Error(text || `${tool} 执行失败`);
    if (!text) throw new Error(`${tool} 返回了空结果`);
    try { return JSON.parse(text); }
    catch { throw new Error(`${tool} 返回格式已变化，已停止自动操作`); }
  }

  fail(error) {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.fail(new Error('本地连接已关闭'));
    this.socket.destroy();
  }
}

async function logRoots() {
  const local = process.env.LOCALAPPDATA;
  const roots = [];
  if (local) {
    roots.push(path.join(local, 'Codex', 'Logs'));
    const packages = path.join(local, 'Packages');
    for (const entry of await fs.readdir(packages, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && entry.name.startsWith('OpenAI.Codex_')) {
        roots.push(path.join(packages, entry.name, 'LocalCache', 'Local', 'Codex', 'Logs'));
      }
    }
  }
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'Codex', 'Logs'));
  return roots;
}

export async function discoverPipes() {
  const candidates = new Set();
  const add = value => {
    if (typeof value === 'string' && value.startsWith('\\\\.\\pipe\\')) candidates.add(value);
  };
  add(process.env.CODEX_APP_TOOLS_PIPE_PATH);
  const logs = [];
  for (const root of await logRoots()) {
    const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('-0.log')) continue;
      const file = path.join(entry.parentPath, entry.name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat) logs.push({ file, mtime: stat.mtimeMs });
    }
  }
  logs.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of logs.slice(0, 12)) {
    const handle = await fs.open(file, 'r').catch(() => null);
    if (!handle) continue;
    try {
      const buffer = Buffer.alloc(128 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      for (const line of buffer.toString('utf8', 0, bytesRead).split(/\r?\n/)) {
        if (line.includes('dynamic_app_tools_listening')) add(line.match(/pipePath=(\\\\\.\\pipe\\[^\s]+)/)?.[1]);
      }
    } finally { await handle.close(); }
  }
  // Browser extensions share this pipe-name prefix. Use the app's own log to
  // distinguish its tools pipe, rather than probing unrelated browser services.
  const pipes = await fs.readdir('\\\\.\\pipe\\').catch(() => null);
  const live = pipes ? new Set(pipes) : null;
  return [...candidates].filter(pipe => !live || live.has(pipe.slice('\\\\.\\pipe\\'.length)));
}

export async function connectDesktop(controllerThreadId) {
  if (process.platform !== 'win32') throw new Error('此脚本适用于 Windows Codex 桌面端');
  const candidates = await discoverPipes();
  let denied = false;
  // The first candidates come from the app's own startup log, normally one probe.
  for (const pipe of candidates) {
    try { return await DesktopClient.connect(pipe, controllerThreadId); }
    catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') denied = true; }
  }
  if (denied) throw new Error('本地管道访问被限制；请在普通 Windows PowerShell 中启动脚本');
  throw new Error('未找到兼容的 Codex 桌面端；请打开 Codex 并保持登录');
}
