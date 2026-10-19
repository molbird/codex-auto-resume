import { createHash } from 'node:crypto';
import { usageGate, quotaFailure, failureKey, normalizeCwd } from './policy.mjs';

export class FatalMonitorError extends Error {}

export class Monitor {
  constructor({ client, config, state, listThreads, save = () => {}, log = () => {},
    now = Date.now, stopping = () => false }) {
    Object.assign(this, { client, config, state, listThreads, save, log, now, stopping });
    this.cache = new Map();
    this.excluded = new Set([...config.excludeThreadIds, config.controllerThreadId]);
  }

  verifyAccount(usage) {
    if (this.state.accountId && usage.accountId && this.state.accountId !== usage.accountId) {
      throw new FatalMonitorError('当前登录账户与 runtime/state.json 的账户记录不一致，已停止监控，请先核实账户');
    }
    if (usage.accountId && !this.state.accountId) this.state.accountId = usage.accountId;
  }

  async inspect(row) {
    const previous = this.cache.get(row.id);
    if (previous && previous.revision === row.revision && previous.status !== 'active'
      && this.now() - previous.checkedAt < this.config.refreshUnchangedMinutes * 60_000) return;
    try {
      const result = await this.client.call('read_thread', {
        threadId: row.id, hostId: 'local', turnLimit: 1,
        includeOutputs: false, maxOutputCharsPerItem: 0,
      });
      const thread = result.thread;
      const status = typeof thread?.status === 'string' ? thread.status : thread?.status?.type;
      const failure = quotaFailure(result);
      this.cache.set(row.id, { revision: row.revision, checkedAt: this.now(), status,
        cwd: thread?.cwd || row.cwd, failure });
      if (failure && (!previous?.failure || failureKey(previous.failure) !== failureKey(failure))) {
        this.log('INFO', `检测到额度停止：${failure.title} (${failure.threadId})；失败轮次 ${failure.turnId}`);
      }
    } catch (error) {
      // Never make a resume decision from stale evidence after a failed read.
      this.cache.delete(row.id);
      this.log('WARN', `无法读取聊天 ${row.id}：${error.message}`);
      if (this.client.closed) throw error;
    }
  }

  activeInfo() {
    const active = [...this.cache.entries()].filter(([, value]) => value.status === 'active');
    const ours = new Set(Object.values(this.state.attempts).map(attempt => attempt.threadId));
    return { count: active.filter(([id]) => ours.has(id)).length,
      directories: new Set(active.map(([, value]) => normalizeCwd(value.cwd)).filter(Boolean)) };
  }

  async tick({ dryRun = false } = {}) {
    const usage = await this.client.call('get_usage_limits');
    this.verifyAccount(usage);
    const gate = usageGate(usage, this.now(), this.config.resetGraceSeconds);
    if (!gate.allowed && gate.resetAt) this.state.waitUntil = gate.resetAt * 1000;
    const rows = this.listThreads().filter(row => !this.excluded.has(row.id));
    const existing = new Set(rows.map(row => row.id));
    for (const id of this.cache.keys()) if (!existing.has(id)) this.cache.delete(id);
    let position = 0;
    // Four read-only inspections at a time; mutations below remain sequential.
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
      while (position < rows.length && !this.stopping()) await this.inspect(rows[position++]);
    }));
    const failures = rows.map(row => this.cache.get(row.id)?.failure).filter(Boolean);
    const pending = failures.filter(failure => !this.state.attempts[failureKey(failure)]);
    const report = {
      checkedAt: new Date(this.now()).toISOString(), localThreads: rows.length,
      inspectedThreads: this.cache.size, quotaStoppedThreads: failures.length,
      pendingThreads: pending.length, resumedThisCheck: 0,
      usageAllowed: gate.allowed, reason: gate.reason,
      resetAt: gate.resetAt ? new Date(gate.resetAt * 1000).toISOString() : null,
      primaryUsedPercent: (usage.rateLimitsByLimitId?.codex ?? usage.rateLimits)?.primary?.usedPercent ?? null,
      weeklyUsedPercent: (usage.rateLimitsByLimitId?.codex ?? usage.rateLimits)?.secondary?.usedPercent ?? null,
      dryRun,
    };
    if (dryRun || !gate.allowed || this.stopping() || this.now() < (this.state.waitUntil || 0)) {
      if (!dryRun) this.save(this.state);
      return report;
    }

    for (const failure of pending) {
      if (this.stopping()) break;
      const active = this.activeInfo();
      if (active.count >= this.config.maxConcurrentResumes) break;
      if (active.directories.has(normalizeCwd(failure.cwd))) continue;
      const prior = Object.values(this.state.attempts).filter(a => a.threadId === failure.threadId);
      if (prior.some(a => this.now() - a.attemptedAt < this.config.retryCooldownSeconds * 1000)) continue;

      // Re-read immediately before sending: a user may have completed, paused,
      // resumed, or archived the thread since the scan above.
      const fresh = await this.client.call('read_thread', {
        threadId: failure.threadId, hostId: 'local', turnLimit: 1,
        includeOutputs: false, maxOutputCharsPerItem: 0,
      });
      const current = quotaFailure(fresh);
      if (!current || failureKey(current) !== failureKey(failure)) {
        this.cache.delete(failure.threadId);
        continue;
      }
      // The local index is authoritative for archive state, including unloaded chats.
      if (!this.listThreads().some(row => row.id === failure.threadId)) continue;
      const freshUsage = await this.client.call('get_usage_limits');
      this.verifyAccount(freshUsage);
      const freshGate = usageGate(freshUsage, this.now(), this.config.resetGraceSeconds);
      if (!freshGate.allowed) {
        if (freshGate.resetAt) this.state.waitUntil = freshGate.resetAt * 1000;
        report.usageAllowed = false;
        report.reason = freshGate.reason;
        report.resetAt = freshGate.resetAt ? new Date(freshGate.resetAt * 1000).toISOString() : null;
        break;
      }
      const key = failureKey(failure);
      const marker = createHash('sha256').update(key).digest('hex').slice(0, 16);
      const attempt = { threadId: failure.threadId, failedTurnId: failure.turnId,
        attemptedAt: this.now(), status: 'sending' };
      // Persist BEFORE the side effect. If the app accepts a message and the
      // connection dies, a restarted watcher must not send it a second time.
      this.state.attempts[key] = attempt;
      this.save(this.state);
      try {
        const response = await this.client.call('send_message_to_thread', {
          threadId: failure.threadId, hostId: 'local',
          prompt: `${this.config.resumePrompt}\n\n[自动续跑编号：${marker}]`,
        });
        if (response?.error || response?.isError === true) throw new Error('桌面端未接受续跑消息');
        attempt.status = 'sent';
        attempt.acceptedAt = this.now();
        report.resumedThisCheck++;
        const cached = this.cache.get(failure.threadId);
        if (cached) cached.status = 'active';
        this.log('INFO', `已提交续跑：${failure.title} (${failure.threadId})`);
      } catch (error) {
        attempt.status = 'uncertain';
        this.log('WARN', `续跑结果需核实，已防止重复发送：${failure.threadId}；${error.message}`);
        if (this.client.closed) {
          this.save(this.state);
          throw error;
        }
      }
      this.save(this.state);
    }
    this.save(this.state);
    return report;
  }
}
