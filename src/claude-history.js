import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeFailureInfo } from './utils.js';

function readJsonLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function belongsToProject(candidate, projectPath) {
  if (!candidate || !projectPath) return false;
  const root = path.resolve(projectPath);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (relative === '') return true;
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;

  // Claude Code 可能从仓库子目录启动；若子目录本身是另一个仓库，则不混入父项目。
  let current = resolved;
  while (current !== root) {
    if (fs.existsSync(path.join(current, '.git'))) return false;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return true;
}

function contentText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text.trim()).filter(Boolean).join('\n\n');
}

function userFacingPrompt(value = '') {
  const text = String(value).trim();
  const wrapped = text.match(/(?:^|\n)用户任务：\s*\n([\s\S]*?)(?:\n\s*执行要求：|$)/);
  return (wrapped?.[1] || text).trim();
}

function usefulTitle(...values) {
  for (const value of values) {
    const text = userFacingPrompt(value);
    const line = text.split('\n').map((item) => item.trim()).find((item) => item && !item.startsWith('/'));
    if (line) return line.length > 72 ? `${line.slice(0, 72)}…` : line;
  }
  return 'Claude Code 会话';
}

function claudeProjectIndexes(claudeHome) {
  const projectsDir = path.join(claudeHome, 'projects');
  let directories = [];
  try { directories = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((item) => item.isDirectory()); } catch { return []; }
  return directories.flatMap((directory) => {
    const indexPath = path.join(projectsDir, directory.name, 'sessions-index.json');
    const index = readJson(indexPath);
    return Array.isArray(index?.entries) ? index.entries.map((entry) => ({ ...entry, originalPath: index.originalPath })) : [];
  });
}

function findTranscript(claudeHome, sessionId, hintedPath = '') {
  if (!sessionId) return null;
  if (hintedPath && fs.existsSync(hintedPath)) return hintedPath;
  const projectsDir = path.join(claudeHome, 'projects');
  let directories = [];
  try { directories = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((item) => item.isDirectory()); } catch { return null; }
  for (const directory of directories) {
    const candidate = path.join(projectsDir, directory.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function taskFinalReply(task) {
  if (!task) return '';
  const result = task.result;
  const failure = task.status === 'failed'
    ? claudeFailureInfo(result?.summary, task.error_message, task.raw_result)
    : null;
  if (failure) return `${failure.title}\n${failure.message}`;
  if (result?.summary) {
    const details = [
      ...(result.completed_items || []),
      ...(result.validation || []).map((item) => `${item.passed ? '✓' : '×'} ${item.name}${item.details ? `：${item.details}` : ''}`),
      ...(result.risks || []).map((item) => `注意：${item}`),
      result.question ? `需要补充：${result.question}` : '',
    ].filter(Boolean);
    return [result.summary, ...details].join('\n');
  }
  return task.error_message || '';
}

function cleanAssistantText(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  if (value.startsWith('{') && value.includes('"is_error"')) return '';
  return value;
}

function parseTranscript(filePath, fallbackPrompts = [], task = null) {
  const events = filePath ? readJsonLines(filePath) : [];
  const turns = [];
  let activeTurn = null;

  const finishTurn = () => {
    if (!activeTurn) return;
    const reply = activeTurn.replies.at(-1) || '';
    turns.push({
      role: 'user', text: activeTurn.prompt, timestamp: activeTurn.timestamp, sourceId: activeTurn.sourceId,
    });
    if (reply) turns.push({
      role: 'assistant', text: reply.text, timestamp: reply.timestamp, sourceId: reply.sourceId,
    });
    activeTurn = null;
  };

  for (const [eventIndex, event] of events.entries()) {
    if (event.type === 'user' && event.message?.role === 'user' && !event.toolUseResult) {
      const prompt = userFacingPrompt(contentText(event.message.content));
      if (!prompt) continue;
      finishTurn();
      activeTurn = {
        prompt, timestamp: event.timestamp || '',
        sourceId: event.uuid || `user:${eventIndex}`, replies: [],
      };
      continue;
    }
    if (event.type === 'assistant' && event.message?.role === 'assistant' && activeTurn) {
      const reply = cleanAssistantText(contentText(event.message.content));
      if (reply) activeTurn.replies.push({
        text: reply, timestamp: event.timestamp || '', sourceId: event.uuid || `assistant:${eventIndex}`,
      });
    }
  }
  finishTurn();

  if (!turns.length) {
    for (const [index, prompt] of fallbackPrompts.entries()) turns.push({
      role: 'user',
      text: userFacingPrompt(prompt.display),
      timestamp: prompt.timestamp ? new Date(prompt.timestamp).toISOString() : '',
      sourceId: prompt.uuid || `history:${prompt.timestamp || index}`,
    });
  }

  const finalReply = task?.source_type === 'claude_history' ? '' : taskFinalReply(task);
  if (finalReply) {
    const userMessages = turns.filter((message) => message.role === 'user');
    return [...userMessages, { role: 'assistant', text: finalReply, timestamp: task?.completed_at || task?.updated_at || '' }];
  }
  return turns;
}

export function listProjectClaudeConversations(project, tasks = [], options = {}) {
  const claudeHome = options.claudeHome || path.join(os.homedir(), '.claude');
  const history = readJsonLines(path.join(claudeHome, 'history.jsonl'))
    .filter((entry) => belongsToProject(entry.project, project.path) && entry.sessionId);
  const indexes = claudeProjectIndexes(claudeHome)
    .filter((entry) => belongsToProject(entry.projectPath || entry.originalPath, project.path));
  const conversations = new Map();

  const ensure = (sessionId) => {
    if (!conversations.has(sessionId)) conversations.set(sessionId, { sessionId, prompts: [], source: 'Claude Code' });
    return conversations.get(sessionId);
  };

  for (const entry of history) {
    const conversation = ensure(entry.sessionId);
    conversation.prompts.push(entry);
    conversation.createdAt ||= entry.timestamp ? new Date(entry.timestamp).toISOString() : '';
    conversation.modifiedAt = entry.timestamp ? new Date(entry.timestamp).toISOString() : conversation.modifiedAt;
  }
  for (const entry of indexes) Object.assign(ensure(entry.sessionId), {
    title: entry.customTitle || entry.firstPrompt,
    createdAt: entry.created || ensure(entry.sessionId).createdAt,
    modifiedAt: entry.modified || ensure(entry.sessionId).modifiedAt,
    messageCount: Number(entry.messageCount || 0),
    transcriptPath: entry.fullPath,
    gitBranch: entry.gitBranch || '',
  });
  for (const task of tasks) {
    if (!task.session_id) continue;
    Object.assign(ensure(task.session_id), {
      title: task.title || task.prompt,
      createdAt: task.created_at,
      modifiedAt: task.completed_at || task.updated_at,
      taskId: task.id,
      task,
      source: 'Done 任务',
      gitBranch: task.branch_name || '',
    });
  }

  return [...conversations.values()].map((conversation) => {
    const transcriptPath = findTranscript(claudeHome, conversation.sessionId, conversation.transcriptPath);
    const visibleMessages = parseTranscript(transcriptPath, conversation.prompts, conversation.task);
    return {
      ...conversation,
      title: usefulTitle(conversation.title, conversation.prompts[0]?.display),
      preview: userFacingPrompt(conversation.prompts.at(-1)?.display || conversation.title || ''),
      messageCount: visibleMessages.length,
      transcriptPath,
    };
  }).sort((left, right) => String(right.modifiedAt || right.createdAt || '').localeCompare(String(left.modifiedAt || left.createdAt || '')));
}

export function getProjectClaudeConversation(project, tasks, sessionId, options = {}) {
  const conversation = listProjectClaudeConversations(project, tasks, options).find((item) => item.sessionId === sessionId);
  if (!conversation) return null;
  return {
    ...conversation,
    messages: parseTranscript(conversation.transcriptPath, conversation.prompts, conversation.task),
  };
}
