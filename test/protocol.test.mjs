import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopClient } from '../lib/desktop-client.mjs';
import { Monitor } from '../lib/monitor.mjs';
import { config, usage, snapshot } from './fixtures.mjs';

test('framed desktop protocol performs a complete simulated reset and resume', async t => {
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\codex-auto-resume-test-${randomUUID()}`
    : path.join(os.tmpdir(), `codex-resume-${randomUUID()}.sock`);
  let exhausted = true, sends = 0;
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE(0);
        if (buffer.length < size + 4) break;
        const message = JSON.parse(buffer.subarray(4, size + 4));
        buffer = buffer.subarray(size + 4);
        let result;
        if (message.method === 'tools/list') {
          result = { tools: ['get_usage_limits', 'read_thread', 'send_message_to_thread']
            .map(name => ({ namespace: 'codex_app', name })) };
        } else {
          assert.equal(message.params.hostId, 'local');
          let value;
          if (message.params.tool === 'get_usage_limits') value = usage(exhausted ? 100 : 0);
          else if (message.params.tool === 'read_thread') value = snapshot('a');
          else if (message.params.tool === 'send_message_to_thread') {
            assert.equal(exhausted, false);
            assert.equal(message.params.arguments.threadId, 'a');
            sends++;
            value = { status: 'started', threadId: 'a' };
          } else throw new Error('Unexpected tool');
          result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
        }
        const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
        const frame = Buffer.alloc(4 + body.length);
        frame.writeUInt32LE(body.length);
        body.copy(frame, 4);
        // Exercise fragmented headers and payloads instead of one-buffer assumptions.
        socket.write(frame.subarray(0, 2));
        socket.write(frame.subarray(2, 7));
        socket.write(frame.subarray(7));
      }
    });
  });
  await new Promise(resolve => server.listen(endpoint, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const client = await DesktopClient.connect(endpoint, 'controller');
  t.after(() => client.close());
  const monitor = new Monitor({ client, config,
    state: { version: 1, accountId: null, waitUntil: 0, attempts: {} },
    listThreads: () => [{ id: 'a', revision: 1 }], now: () => 2_500_000 });
  await monitor.tick();
  assert.equal(sends, 0);
  exhausted = false;
  await monitor.tick();
  assert.equal(sends, 1);
  await monitor.tick();
  assert.equal(sends, 1);
});
