import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor, FatalMonitorError } from '../lib/monitor.mjs';
import { config, harness, usage, snapshot } from './fixtures.mjs';

test('exhaustion -> verified reset -> original thread resume, with grace and deduplication', async () => {
  const h = harness();
  h.setUsage(usage(100));
  h.setTime(999_000);
  const monitor = new Monitor(h);
  await monitor.tick();
  assert.equal(h.sends().length, 0);
  h.setUsage(usage(0));
  h.setTime(1_010_000);
  await monitor.tick();
  assert.equal(h.sends().length, 0, '20-second reset grace is respected');
  h.setTime(1_021_000);
  await monitor.tick();
  assert.equal(h.sends().length, 2);
  for (const send of h.sends()) {
    assert.equal(send.args.hostId, 'local');
    assert.equal(Object.hasOwn(send.args, 'model'), false);
    assert.equal(Object.hasOwn(send.args, 'thinking'), false);
  }
  await new Monitor(h).tick();
  assert.equal(h.sends().length, 2, 'restart does not duplicate the same failure');
});

test('check mode never sends or persists', async () => {
  const h = harness();
  assert.equal((await new Monitor(h).tick({ dryRun: true })).pendingThreads, 2);
  assert.equal(h.sends().length, 0);
  assert.equal(h.events.filter(e => e.tool === 'save').length, 0);
});

test('completed, interrupted, active, and excluded chats remain untouched', async () => {
  const h = harness();
  h.snapshots.a = snapshot('a', { turn: { status: 'completed', error: null } });
  h.snapshots.b = snapshot('b', { turn: { status: 'interrupted' } });
  h.snapshots.c = snapshot('c', { thread: { status: { type: 'active' } } });
  h.snapshots.controller = snapshot('controller');
  await new Monitor(h).tick();
  assert.equal(h.sends().length, 0);
});

test('a chat that completes between inspection and dispatch is not resumed', async () => {
  const h = harness();
  delete h.snapshots.b;
  const original = h.client.call;
  let reads = 0;
  h.client.call = async (tool, args) => {
    if (tool === 'read_thread' && ++reads === 2) return snapshot('a', { turn: { status: 'completed', error: null } });
    return original(tool, args);
  };
  await new Monitor(h).tick();
  assert.equal(h.sends().length, 0);
});

test('a manual continuation supersedes the earlier desktop quota failure', async () => {
  const h = harness();
  delete h.snapshots.b;
  const failed = h.snapshots.a.turns[0];
  h.snapshots.a.thread.status = { type: 'active', activeFlags: [] };
  h.snapshots.a.turns = [{ id: 'manual-continuation', status: 'inProgress', error: null,
    items: [], startedAt: 1100, completedAt: null }, failed];
  const report = await new Monitor(h).tick();
  assert.equal(report.quotaStoppedThreads, 0);
  assert.equal(h.sends().length, 0);
});

test('an archive during inspection prevents sending', async () => {
  const h = harness();
  delete h.snapshots.b;
  const original = h.listThreads;
  let reads = 0;
  h.listThreads = () => ++reads === 1 ? original() : [];
  await new Monitor(h).tick();
  assert.equal(h.sends().length, 0);
});

test('rechecks usage immediately before sending', async () => {
  const h = harness();
  const original = h.client.call;
  let reads = 0;
  h.client.call = async (tool, args) => {
    if (tool === 'get_usage_limits' && ++reads === 2) return usage(100);
    return original(tool, args);
  };
  await new Monitor(h).tick();
  assert.equal(h.sends().length, 0);
});

test('records before dispatch and does not duplicate an uncertain send', async () => {
  const h = harness();
  delete h.snapshots.b;
  const original = h.client.call;
  h.client.call = async (tool, args) => {
    if (tool === 'send_message_to_thread') {
      assert.equal(h.events.at(-1).tool, 'save');
      assert.equal(h.state.attempts['a:a-failed-1'].status, 'sending');
      h.events.push({ tool, args });
      throw new Error('connection closed after dispatch');
    }
    return original(tool, args);
  };
  await new Monitor(h).tick();
  assert.equal(h.state.attempts['a:a-failed-1'].status, 'uncertain');
  await new Monitor(h).tick();
  assert.equal(h.sends().length, 1);
});

test('parallel restores respect the same project directory', async () => {
  const h = harness();
  h.snapshots.b.thread.cwd = '\\\\?\\D:\\projects\\a\\';
  await new Monitor(h).tick();
  assert.equal(h.sends().length, 1);
});

test('respects max concurrent restores', async () => {
  const h = harness({ maxConcurrentResumes: 1 });
  await new Monitor(h).tick();
  assert.equal(h.sends().length, 1);
});

test('a new quota failure can be retried after cooldown', async () => {
  const h = harness();
  delete h.snapshots.b;
  const monitor = new Monitor(h);
  await monitor.tick();
  h.snapshots.a.turns[0].id = 'new-failure';
  h.setTime(2_100_000);
  await monitor.tick();
  assert.equal(h.sends().length, 1);
  h.setTime(2_301_000);
  await monitor.tick();
  assert.equal(h.sends().length, 2);
});

test('account changes stop the monitor', async () => {
  const h = harness();
  h.state.accountId = 'a-different-account';
  await assert.rejects(new Monitor(h).tick(), FatalMonitorError);
  assert.equal(h.sends().length, 0);
});

test('stop request prevents all sending', async () => {
  const h = harness();
  await new Monitor({ ...h, stopping: () => true }).tick();
  assert.equal(h.sends().length, 0);
});
