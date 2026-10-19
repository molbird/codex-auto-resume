import test from 'node:test';
import assert from 'node:assert/strict';
import { usageGate, quotaFailure, normalizeCwd } from '../lib/policy.mjs';
import { isRootSource } from '../lib/thread-index.mjs';
import { usage, snapshot } from './fixtures.mjs';

test('requires fresh backend permission for ordinary usage', () => {
  assert.equal(usageGate(usage()).allowed, true);
  for (const permission of [false, null, undefined]) {
    const limits = usage(5, 5);
    limits.ordinaryUsageAllowed = permission;
    assert.equal(usageGate(limits).allowed, false);
  }
});

test('does not infer recovery from an expired reset timestamp', () => {
  assert.equal(usageGate(usage(100), 100_000_000).allowed, false);
});

test('weekly exhaustion wins even when five-hour usage is low', () => {
  const result = usageGate(usage(1, 100), 0, 20);
  assert.equal(result.allowed, false);
  assert.equal(result.resetAt, 2020);
});

test('waits for the later reset when both windows are exhausted', () => {
  assert.equal(usageGate(usage(100, 100), 0, 20).resetAt, 2020);
});

test('prefers the codex multi-bucket view to the legacy view', () => {
  assert.equal(usageGate({ ...usage(100), rateLimits: { primary: { usedPercent: 0 } } }).allowed, false);
});

test('spend and account restrictions block resuming', () => {
  const limits = usage();
  limits.rateLimitsByLimitId.codex.spendControlReached = true;
  assert.equal(usageGate(limits).allowed, false);
  delete limits.rateLimitsByLimitId.codex.spendControlReached;
  limits.rateLimitsByLimitId.codex.rateLimitReachedType = 'workspace_member_usage_limit_reached';
  assert.equal(usageGate(limits).allowed, false);
});

test('only the latest structured usage failure qualifies', () => {
  assert.equal(quotaFailure(snapshot()).threadId, 'chat-a');
  const complete = snapshot('chat-a', { turn: { status: 'completed', error: null } });
  complete.turns.push(snapshot().turns[0]);
  assert.equal(quotaFailure(complete), null);
});

test('recognizes desktop usage errors without a code and with typographic apostrophes', () => {
  const observed = snapshot();
  assert.equal(Object.hasOwn(observed.turns[0].error, 'codexErrorInfo'), false);
  assert.equal(quotaFailure(observed)?.threadId, 'chat-a');
  for (const apostrophe of ["'", '’', '‘', 'ʼ', '＇']) {
    const error = { message: `You${apostrophe}ve hit your usage limit. Try again later.` };
    assert.equal(quotaFailure(snapshot('a', { turn: { error } }))?.threadId, 'a');
  }
});

test('also recognizes the structured usage code when the message is unavailable', () => {
  const error = { codexErrorInfo: 'usageLimitExceeded', message: '' };
  assert.equal(quotaFailure(snapshot('a', { turn: { error } }))?.threadId, 'a');
});

test('user interruption, approvals, and other errors are never quota failures', () => {
  assert.equal(quotaFailure(snapshot('a', { turn: { status: 'interrupted' } })), null);
  assert.equal(quotaFailure(snapshot('a', { thread: { status: { type: 'active', activeFlags: ['waitingOnApproval'] } } })), null);
  assert.equal(quotaFailure(snapshot('a', { turn: { error: { codexErrorInfo: 'rateLimitExceeded', message: 'Too many requests' } } })), null);
  assert.equal(quotaFailure(snapshot('a', { turn: { error: { codexErrorInfo: 'unauthorized', message: 'Unauthorized' } } })), null);
});

test('remote and ChatGPT conversations are excluded', () => {
  assert.equal(quotaFailure(snapshot('a', { thread: { hostId: 'remote' } })), null);
  assert.equal(quotaFailure(snapshot('a', { thread: { kind: 'chatgpt' } })), null);
});

test('quoted quota text in user or assistant items is not evidence', () => {
  const data = snapshot('a', { turn: { status: 'completed', error: null,
    items: [{ type: 'userMessage', text: '额度耗尽 usageLimitExceeded' }] } });
  assert.equal(quotaFailure(data), null);
});

test('excludes guardian and other subagents from the local index', () => {
  assert.equal(isRootSource('{"subagent":{"other":"guardian"}}'), false);
  assert.equal(isRootSource('{"subAgent":{"thread_spawn":{}}}'), false);
  assert.equal(isRootSource('vscode'), true);
  assert.equal(isRootSource('"cli"'), true);
  assert.equal(isRootSource('{"custom":"local-client"}'), true);
});

test('normalizes Windows extended paths for project concurrency', () => {
  assert.equal(normalizeCwd('\\\\?\\D:\\Projects\\Test\\'), normalizeCwd('d:/projects/test'));
});
