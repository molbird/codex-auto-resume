export function usageGate(response, nowMs = Date.now(), graceSeconds = 20) {
  const bucket = response?.rateLimitsByLimitId?.codex ?? response?.rateLimits;
  if (!bucket) return { allowed: false, reason: '额度数据不可用', resetAt: null };
  const blocked = [bucket.primary, bucket.secondary].filter(window =>
    Number.isFinite(window?.usedPercent) && window.usedPercent >= 100);
  const resetTimes = blocked.map(window => window.resetsAt)
    .filter(time => Number.isFinite(time) && time > 0);
  const resetAt = resetTimes.length ? Math.max(...resetTimes) + graceSeconds : null;
  if (blocked.length) return { allowed: false, reason: '5 小时或每周额度已耗尽', resetAt };
  if (bucket.spendControlReached === true || bucket.rateLimitReachedType != null) {
    return { allowed: false, reason: '账户仍受到使用限制', resetAt };
  }
  // A past reset timestamp or a low percentage does NOT prove recovery.
  // The current backend explicitly supplies permission for included usage.
  if (response.ordinaryUsageAllowed !== true) {
    return { allowed: false, reason: '服务端尚未确认普通额度可用', resetAt };
  }
  return { allowed: true, reason: '服务端已确认额度可用', resetAt: null };
}

export function quotaFailure(snapshot) {
  const thread = snapshot?.thread;
  const status = typeof thread?.status === 'string' ? thread.status : thread?.status?.type;
  if (!thread || thread.kind !== 'codex' || thread.hostId !== 'local') return null;
  if (!['idle', 'notLoaded', 'systemError'].includes(status)) return null;
  // read_thread returns newest-first. Never search older failed turns when a
  // later turn has completed, been interrupted, or is waiting for the user.
  const turn = snapshot.turns?.[0];
  if (turn?.status !== 'failed' || !turn.id || !turn.error) return null;
  const code = typeof turn.error.codexErrorInfo === 'string'
    ? turn.error.codexErrorInfo.replace(/[_-]/g, '').toLowerCase() : '';
  // Desktop read_thread can omit codexErrorInfo and use “You’ve” (U+2019).
  // Canonicalize punctuation before checking the backend error message.
  const message = String(turn.error.message || '').normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc]/gu, "'");
  const isQuota = code === 'usagelimitexceeded' || /(?:you(?:'ve| have) hit your usage limit|usage quota (?:exceeded|exhausted)|insufficient_quota|额度(?:已)?(?:耗尽|用完))/i.test(message);
  if (!isQuota) return null;
  return { threadId: thread.id, turnId: turn.id, title: thread.title || thread.id,
    cwd: thread.cwd, failedAt: turn.completedAt || turn.startedAt || null };
}

export function failureKey(failure) {
  return `${failure.threadId}:${failure.turnId}`;
}

export function normalizeCwd(cwd = '') {
  return cwd.replace(/^\\\\\?\\/, '').replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
}
