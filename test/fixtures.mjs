// These helpers never connect to the real app. The error below was captured
// from read_thread on 2026-10-13: no codexErrorInfo, and a Unicode apostrophe.
export const desktopUsageError = {
  message: 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 13th, 2026 1:28 AM.',
  additionalDetails: null,
};

export function usage(primary = 10, weekly = 20, ordinaryUsageAllowed = true) {
  return { accountId: 'account-a', ordinaryUsageAllowed,
    rateLimitsByLimitId: { codex: { primary: { usedPercent: primary, resetsAt: 1000 },
      secondary: { usedPercent: weekly, resetsAt: 2000 }, rateLimitReachedType: null } } };
}

export function snapshot(id = 'chat-a', options = {}) {
  return { thread: { id, kind: 'codex', hostId: 'local', title: id,
    cwd: `D:\\projects\\${id}`, status: { type: 'idle' }, ...options.thread },
    turns: [{ id: `${id}-failed-1`, status: 'failed', completedAt: 900,
      error: { ...desktopUsageError },
      items: [], ...options.turn }] };
}

export const config = { pollSeconds: 60, resetGraceSeconds: 20, maxConcurrentResumes: 2,
  retryCooldownSeconds: 300, refreshUnchangedMinutes: 15,
  controllerThreadId: 'controller', excludeThreadIds: ['controller'], resumePrompt: '继续原任务。' };

export function harness(overrides = {}) {
  const snapshots = { a: snapshot('a'), b: snapshot('b') };
  const state = { version: 1, accountId: null, waitUntil: 0, attempts: {} };
  const events = [];
  let currentUsage = usage(), nowMs = 2_000_000;
  const client = { closed: false, call: async (tool, args) => {
    events.push({ tool, args: structuredClone(args) });
    if (tool === 'get_usage_limits') return structuredClone(currentUsage);
    if (tool === 'read_thread') return structuredClone(snapshots[args.threadId]);
    if (tool === 'send_message_to_thread') return { threadId: args.threadId, status: 'started' };
    throw new Error(`Unexpected tool ${tool}`);
  } };
  return { client, config: { ...config, ...overrides }, state, snapshots, events,
    listThreads: () => Object.values(snapshots).map(value => ({ id: value.thread.id,
      cwd: value.thread.cwd, revision: 1 })),
    now: () => nowMs, save: () => events.push({ tool: 'save' }),
    setUsage: value => { currentUsage = value; }, setTime: value => { nowMs = value; },
    sends: () => events.filter(event => event.tool === 'send_message_to_thread') };
}
