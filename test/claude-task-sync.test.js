import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncProjectClaudeHistoryTasks } from '../src/claude-task-sync.js';

function writeConversation(claudeHome, projectPath, sessionId, events, index = {}) {
  const projectDir = path.join(claudeHome, 'projects', 'fixture');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'history.jsonl'), JSON.stringify({
    display: index.firstPrompt ?? '修复登录测试',
    timestamp: Date.parse('2026-08-09T01:00:00.000Z'),
    project: projectPath,
    sessionId,
  }));
  fs.writeFileSync(path.join(projectDir, 'sessions-index.json'), JSON.stringify({
    originalPath: projectPath,
    entries: [{
      sessionId,
      firstPrompt: index.firstPrompt ?? '修复登录测试',
      projectPath,
      created: '2026-08-09T01:00:00.000Z',
      modified: '2026-08-09T01:05:00.000Z',
      fullPath: path.join(projectDir, `${sessionId}.jsonl`),
      ...index,
    }],
  }));
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), events.map((event) => JSON.stringify(event)).join('\n'));
}

function conversationEvents() {
  return [
    { type: 'user', timestamp: '2026-08-09T01:00:00.000Z', message: { role: 'user', content: '修复登录测试' } },
    { type: 'assistant', timestamp: '2026-08-09T01:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '我先检查相关代码。' }] } },
    { type: 'assistant', timestamp: '2026-08-09T01:05:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '登录测试已经修复并通过。' }] } },
  ];
}

test('project history sync imports a Claude session as an accepted task', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-task-sync-'));
  const claudeHome = path.join(temp, '.claude');
  const projectPath = path.join(temp, 'project');
  const project = { id: 'project_1', name: '示例项目', path: projectPath };
  const sessionId = 'session_1';
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  writeConversation(claudeHome, projectPath, sessionId, conversationEvents());
  const created = [];

  try {
    const result = syncProjectClaudeHistoryTasks({
      project,
      existingTasks: [],
      options: { claudeHome },
      createImportedTask(input) {
        created.push(input);
        return { id: 'task_imported', status: 'accepted', phase: '已接受', session_id: input.sessionId, ...input };
      },
    });

    assert.equal(result.discovered, 1);
    assert.equal(result.added.length, 1);
    assert.equal(result.existing, 0);
    assert.equal(result.ignored, 0);
    assert.equal(created[0].sessionId, sessionId);
    assert.equal(created[0].prompt, '修复登录测试');
    assert.equal(created[0].result.outcome, 'accepted');
    assert.equal(created[0].result.summary, '登录测试已经修复并通过。');
    assert.equal(result.added[0].status, 'accepted');
    assert.notEqual(result.added[0].status, 'queued');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('project history sync never overwrites an existing Done task and is idempotent', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-task-sync-existing-'));
  const claudeHome = path.join(temp, '.claude');
  const projectPath = path.join(temp, 'project');
  const project = { id: 'project_1', name: '示例项目', path: projectPath };
  const sessionId = 'session_existing';
  const existingTask = {
    id: 'task_done', project_id: project.id, title: 'Done 中修改后的标题', prompt: 'Done 中的新沟通',
    status: 'accepted', session_id: sessionId, result: { summary: 'Done 中保留的结果' },
  };
  const snapshot = structuredClone(existingTask);
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  writeConversation(claudeHome, projectPath, sessionId, conversationEvents());
  let calls = 0;

  try {
    const sync = () => syncProjectClaudeHistoryTasks({
      project,
      existingTasks: [existingTask],
      options: { claudeHome },
      createImportedTask() { calls += 1; throw new Error('不应创建'); },
    });
    const first = sync();
    const second = sync();

    assert.equal(first.added.length, 0);
    assert.equal(first.existing, 1);
    assert.equal(second.added.length, 0);
    assert.equal(second.existing, 1);
    assert.equal(calls, 0);
    assert.deepEqual(existingTask, snapshot);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('project history sync ignores sessions without a user-facing prompt', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-task-sync-empty-'));
  const claudeHome = path.join(temp, '.claude');
  const projectPath = path.join(temp, 'project');
  const project = { id: 'project_1', name: '示例项目', path: projectPath };
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  writeConversation(claudeHome, projectPath, 'session_empty', [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '只有助手消息' }] } },
  ], { firstPrompt: '' });
  let calls = 0;

  try {
    const result = syncProjectClaudeHistoryTasks({
      project,
      existingTasks: [],
      options: { claudeHome },
      createImportedTask() { calls += 1; },
    });
    assert.equal(result.added.length, 0);
    assert.equal(result.ignored, 1);
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('concurrent duplicate insert is treated as an existing task', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-task-sync-race-'));
  const claudeHome = path.join(temp, '.claude');
  const projectPath = path.join(temp, 'project');
  const project = { id: 'project_1', name: '示例项目', path: projectPath };
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  writeConversation(claudeHome, projectPath, 'session_race', conversationEvents());

  try {
    const result = syncProjectClaudeHistoryTasks({
      project,
      existingTasks: [],
      options: { claudeHome },
      createImportedTask() { throw new Error('UNIQUE constraint failed: tasks.project_id, tasks.session_id'); },
    });
    assert.equal(result.added.length, 0);
    assert.equal(result.existing, 1);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('project history sync imports every completed turn and leaves an unanswered prompt pending', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-task-sync-turns-'));
  const claudeHome = path.join(temp, '.claude');
  const projectPath = path.join(temp, 'project');
  const project = { id: 'project_1', name: '示例项目', path: projectPath };
  const sessionId = 'session_turns';
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  writeConversation(claudeHome, projectPath, sessionId, [
    { uuid: 'user-1', type: 'user', timestamp: '2026-08-09T01:00:00.000Z', message: { role: 'user', content: '先了解项目' } },
    { uuid: 'assistant-1', type: 'assistant', timestamp: '2026-08-09T01:01:00.000Z', message: { role: 'assistant', content: '项目使用 Node.js。' } },
    { uuid: 'user-2', type: 'user', timestamp: '2026-08-09T01:02:00.000Z', message: { role: 'user', content: '跑一下测试' } },
    { uuid: 'assistant-2', type: 'assistant', timestamp: '2026-08-09T01:03:00.000Z', message: { role: 'assistant', content: '测试已通过。' } },
    { uuid: 'user-3', type: 'user', timestamp: '2026-08-09T01:04:00.000Z', message: { role: 'user', content: '再补一份文档' } },
  ]);
  const created = [];

  try {
    const result = syncProjectClaudeHistoryTasks({
      project,
      existingTasks: [],
      options: { claudeHome },
      createImportedTask(input) {
        created.push(input);
        return { id: 'task_turns', session_id: input.sessionId, source_type: 'claude_history' };
      },
    });

    assert.equal(result.added.length, 1);
    assert.equal(result.turnsAdded, 2);
    assert.equal(result.pending, 1);
    assert.deepEqual(created[0].turns.map((turn) => [turn.prompt, turn.result.summary]), [
      ['先了解项目', '项目使用 Node.js。'],
      ['跑一下测试', '测试已通过。'],
    ]);
    assert.deepEqual(created[0].turns.map((turn) => turn.sourceKey), [
      `claude:${sessionId}:user-1`,
      `claude:${sessionId}:user-2`,
    ]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('project history sync delegates existing historical sessions to incremental append', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-task-sync-append-'));
  const claudeHome = path.join(temp, '.claude');
  const projectPath = path.join(temp, 'project');
  const project = { id: 'project_1', name: '示例项目', path: projectPath };
  const sessionId = 'session_append';
  const existingTask = { id: 'task_history', project_id: project.id, session_id: sessionId, source_type: 'claude_history' };
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  writeConversation(claudeHome, projectPath, sessionId, conversationEvents());
  const appended = [];

  try {
    const result = syncProjectClaudeHistoryTasks({
      project,
      existingTasks: [existingTask],
      options: { claudeHome },
      createImportedTask() { throw new Error('不应创建新任务'); },
      appendImportedTaskTurns(input) {
        appended.push(input);
        return {
          task: existingTask,
          addedRuns: [{ id: 'run_new' }],
          protected: false,
          migratedLegacy: false,
        };
      },
    });

    assert.equal(appended.length, 1);
    assert.equal(appended[0].taskId, existingTask.id);
    assert.equal(appended[0].turns[0].result.summary, '登录测试已经修复并通过。');
    assert.equal(result.updated.length, 1);
    assert.equal(result.turnsAdded, 1);
    assert.equal(result.existing, 0);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
