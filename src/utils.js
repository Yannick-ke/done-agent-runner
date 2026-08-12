import { randomUUID } from 'node:crypto';

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function isTerminalStatus(status) {
  return ['completed', 'failed', 'canceled', 'accepted'].includes(status);
}

export function normalizeTask(row) {
  if (!row) return null;
  return {
    ...row,
    result: safeJsonParse(row.result_json),
    attempts: Number(row.attempts || 0),
  };
}

export function normalizeTaskRun(row) {
  if (!row) return null;
  return {
    ...row,
    sequence: Number(row.sequence || 0),
    result: safeJsonParse(row.result_json),
    usage: safeJsonParse(row.usage_json),
  };
}

export function safeJsonParse(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function cleanText(value, maxLength = 100_000) {
  return String(value ?? '').replace(/\0/g, '').slice(0, maxLength);
}

export function claudeFailureInfo(...values) {
  for (const value of values) {
    if (!value) continue;
    let payload = value;
    if (typeof payload === 'string') {
      const text = payload.trim();
      if (!text.startsWith('{')) continue;
      try { payload = JSON.parse(text); } catch { continue; }
    }
    if (!payload || typeof payload !== 'object') continue;

    const errors = Array.isArray(payload.errors) ? payload.errors.map(String) : [];
    const combined = `${payload.subtype || ''} ${payload.terminal_reason || ''} ${errors.join(' ')}`;
    if (/max[_ ]turns|maximum number of turns/i.test(combined)) {
      const turns = combined.match(/(?:turns\s*\()?([0-9]+)\)?/i)?.[1];
      return {
        code: 'max_turns',
        title: '任务未能在本次执行中完成',
        message: `Claude Code 已达到单次任务的最大执行轮数${turns ? `（${turns} 轮）` : ''}。可以缩小任务范围或补充更明确的验收要求后继续执行。`,
      };
    }
    if (/max[_ -]?budget|budget/i.test(combined)) {
      return {
        code: 'max_budget',
        title: '任务因费用上限停止',
        message: 'Claude Code 已达到本次任务的费用上限。可以调整任务范围或提高费用上限后继续执行。',
      };
    }
    if (payload.is_error || payload.type === 'result') {
      return {
        code: payload.subtype || 'claude_error',
        title: 'Claude Code 执行未完成',
        message: errors[0] || 'Claude Code 没有生成可验收的结果。可以补充要求后再次执行。',
      };
    }
  }
  return null;
}

export function taskTitle(prompt) {
  const firstLine = cleanText(prompt, 160).split(/\r?\n/).find(Boolean)?.trim();
  return (firstLine || '未命名任务').slice(0, 80);
}
