import { createHash } from 'node:crypto';
import { getProjectClaudeConversation, listProjectClaudeConversations } from './claude-history.js';

function asIso(value, fallback) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function latestIso(...values) {
  return values.map((value) => asIso(value, '')).filter(Boolean).sort().at(-1) || '';
}

function isUniqueConflict(error) {
  return String(error?.message || error).includes('UNIQUE constraint');
}

function importedResult(reply) {
  return {
    outcome: 'accepted',
    summary: String(reply || '').trim(),
    completed_items: [],
    validation: [],
    risks: [],
    question: '',
  };
}

function sourceKey(sessionId, userMessage, index) {
  if (userMessage.sourceId) return `claude:${sessionId}:${userMessage.sourceId}`;
  return `claude:${sessionId}:${createHash('sha256')
    .update(`${index}\0${userMessage.timestamp || ''}\0${userMessage.text || ''}`)
    .digest('hex')}`;
}

function completedTurns(messages, sessionId) {
  const turns = [];
  let pending = 0;
  let userIndex = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const user = messages[index];
    if (user.role !== 'user' || !String(user.text || '').trim()) continue;
    userIndex += 1;
    const assistant = messages.slice(index + 1).find((message) => message.role === 'user' || message.role === 'assistant');
    if (!assistant || assistant.role !== 'assistant' || !String(assistant.text || '').trim()) {
      pending += 1;
      continue;
    }
    const createdAt = asIso(user.timestamp, new Date().toISOString());
    const completedAt = asIso(assistant.timestamp, createdAt);
    turns.push({
      sourceKey: sourceKey(sessionId, user, userIndex),
      prompt: String(user.text).trim(),
      reply: String(assistant.text).trim(),
      result: importedResult(assistant.text),
      createdAt,
      completedAt,
    });
  }
  return { turns, pending };
}

/**
 * Synchronize Claude Code transcripts into task runs.
 *
 * Existing Done-origin runs are never rewritten. The injected callbacks keep
 * this module independent from HTTP and storage, so manual, scheduled and
 * webhook triggers can all reuse the same synchronization path.
 */
export function syncProjectClaudeHistoryTasks({
  project,
  existingTasks = [],
  createImportedTask,
  appendImportedTaskTurns,
  options = {},
}) {
  if (!project || typeof createImportedTask !== 'function') throw new Error('同步历史任务缺少项目或创建函数。');

  const tasksBySession = new Map(existingTasks.filter((task) => task.session_id)
    .map((task) => [task.session_id, task]));
  // Do not pass linked Done tasks here. Incremental sync must inspect the raw
  // transcript instead of the historical view's task-result fallback.
  const conversations = listProjectClaudeConversations(project, [], options);
  const added = [];
  const updated = [];
  let turnsAdded = 0;
  let existing = 0;
  let ignored = 0;
  let pending = 0;

  for (const conversation of conversations) {
    const detail = getProjectClaudeConversation(project, [], conversation.sessionId, options);
    const parsed = completedTurns(detail?.messages || [], conversation.sessionId);
    pending += parsed.pending;
    if (!parsed.turns.length) {
      if (!parsed.pending) ignored += 1;
      continue;
    }

    const task = tasksBySession.get(conversation.sessionId);
    if (task) {
      if (typeof appendImportedTaskTurns !== 'function') {
        existing += 1;
        continue;
      }
      const syncResult = appendImportedTaskTurns({
        taskId: task.id,
        sessionId: conversation.sessionId,
        turns: parsed.turns,
        sourceUpdatedAt: latestIso(conversation.modifiedAt, parsed.turns.at(-1).completedAt),
      });
      if (syncResult?.protected) {
        existing += 1;
        continue;
      }
      const addedCount = syncResult?.addedRuns?.length || 0;
      turnsAdded += addedCount;
      if (addedCount || syncResult?.migratedLegacy) updated.push(syncResult.task || task);
      else existing += 1;
      continue;
    }

    const firstTurn = parsed.turns[0];
    const lastTurn = parsed.turns.at(-1);
    try {
      const imported = createImportedTask({
        projectId: project.id,
        title: conversation.title || firstTurn.prompt,
        prompt: firstTurn.prompt,
        sessionId: conversation.sessionId,
        result: lastTurn.result,
        turns: parsed.turns,
        createdAt: asIso(conversation.createdAt, firstTurn.createdAt),
        completedAt: lastTurn.completedAt,
        acceptedAt: lastTurn.completedAt,
        sourceUpdatedAt: latestIso(conversation.modifiedAt, lastTurn.completedAt),
      });
      if (imported) {
        added.push(imported);
        turnsAdded += parsed.turns.length;
        tasksBySession.set(conversation.sessionId, imported);
      } else {
        ignored += 1;
      }
    } catch (error) {
      // A concurrent trigger may insert the same session between lookup and
      // INSERT. Treat it as already synchronized and never overwrite it.
      if (isUniqueConflict(error)) existing += 1;
      else throw error;
    }
  }

  return {
    discovered: conversations.length,
    added,
    updated,
    turnsAdded,
    existing,
    ignored,
    pending,
  };
}
