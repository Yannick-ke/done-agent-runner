import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { claudeFailureInfo, cleanText, safeJsonParse, taskTitle } from '../src/utils.js';
import { getProjectClaudeConversation, listProjectClaudeConversations } from '../src/claude-history.js';
import { escapeHtml, homePage, newProjectPage, projectPage, projectsPage, renderMarkdown, taskPage } from '../src/views.js';

test('escapeHtml escapes unsafe characters', () => {
  assert.equal(escapeHtml('<script>"x" & y</script>'), '&lt;script&gt;&quot;x&quot; &amp; y&lt;/script&gt;');
});

test('taskTitle uses first meaningful line and truncates', () => {
  assert.equal(taskTitle('\n修复日期解析\n更多内容'), '修复日期解析');
  assert.equal(taskTitle('a'.repeat(100)).length, 80);
});

test('safeJsonParse returns null for invalid JSON', () => {
  assert.deepEqual(safeJsonParse('{"ok":true}'), { ok: true });
  assert.equal(safeJsonParse('oops'), null);
});

test('cleanText removes null bytes', () => {
  assert.equal(cleanText('a\0b'), 'ab');
});

test('renderMarkdown renders common Claude Markdown safely', () => {
  const html = renderMarkdown('# 完成内容\n\n- 修改 `scripts/sync.sh`\n- **测试通过**\n\n```bash\nnpm test\n```\n\n<script>alert(1)</script>');
  assert.match(html, /<h1>完成内容<\/h1>/);
  assert.match(html, /<li>修改 <code>scripts\/sync\.sh<\/code><\/li>/);
  assert.match(html, /<strong>测试通过<\/strong>/);
  assert.match(html, /<pre><code>npm test<\/code><\/pre>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('claudeFailureInfo explains max-turn failures without exposing raw JSON', () => {
  const info = claudeFailureInfo(JSON.stringify({ is_error: true, subtype: 'error_max_turns', errors: ['Reached maximum number of turns (30)'] }));
  assert.equal(info.code, 'max_turns');
  assert.match(info.title, /未能.*完成/);
  assert.match(info.message, /30 轮/);
});


test('workbench renders project sidebar and status board with active selections', () => {
  const projects = [
    { id: 'project_1', name: '示例项目', path: '/tmp/example', task_count: 2, active_count: 1 },
    { id: 'project_2', name: '另一个项目', path: '/tmp/other', task_count: 1, active_count: 0 },
  ];
  const tasks = [
    { id: 'task_2', project_id: 'project_1', project_name: '示例项目', title: '第二个任务', prompt: '内容', status: 'running', phase: '执行中', created_at: '2026-08-09T02:00:00.000Z' },
    { id: 'task_1', project_id: 'project_1', project_name: '示例项目', title: '第一个任务', prompt: '内容', status: 'completed', phase: '已完成', created_at: '2026-08-09T01:00:00.000Z', result: { summary: '完成', completed_items: [], validation: [], risks: [], question: '' } },
  ];
  const html = homePage({ projects, selectedProject: projects[0], tasks, selectedTask: tasks[0] });
  assert.match(html, /project-sidebar/);
  assert.match(html, /project-sidebar[\s\S]*board-area/);
  assert.match(html, /sidebar-project active[^>]*href="\/projects\/project_1"|href="\/projects\/project_1"[^>]*sidebar-project active/);
  assert.match(html, /另一个项目/);
  assert.match(html, /当前项目/);
  assert.match(html, /<h1>示例项目<\/h1>/);
  assert.match(html, /data-status="queued"[\s\S]*data-status="running"[\s\S]*data-status="needs_input"[\s\S]*data-status="completed"[\s\S]*data-status="accepted"[\s\S]*data-status="failed"[\s\S]*data-status="canceled"/);
  assert.match(html, /board-task active[^>]*href="\/tasks\/task_2"|href="\/tasks\/task_2"[^>]*board-task active/);
  assert.match(html, /task-detail-panel/);
  assert.match(html, /同步历史项目/);
  assert.match(html, /仅新增项目，不覆盖已有任务和沟通/);
  assert.match(html, /同步历史任务/);
  assert.match(html, /action="\/projects\/project_1\/sync-tasks"/);
  assert.match(html, /仅补充新会话，不覆盖已有任务、沟通和结果/);
});

test('workbench renders project and task update times with incremental project pagination', () => {
  const projects = Array.from({ length: 10 }, (_, index) => ({
    id: `project_${index + 1}`,
    name: `项目 ${index + 1}`,
    task_count: index + 1,
    updated_at: '2026-08-10T04:34:00.000Z',
  }));
  const task = {
    id: 'task_recent', project_id: 'project_1', title: '最近更新的任务', prompt: '内容',
    status: 'completed', phase: '已完成', created_at: '2026-08-09T01:00:00.000Z',
    updated_at: '2026-08-10T05:12:00.000Z',
    result: { summary: '完成', completed_items: [], validation: [], risks: [], question: '' },
  };
  const html = homePage({
    projects, selectedProject: projects[0], tasks: [task], selectedTask: null,
    projectListMeta: { hasMore: true, visibleCount: 10, totalCount: 25, nextHref: '/projects?project_limit=20' },
  });
  assert.match(html, /更新 8月10日 12:34/);
  assert.match(html, /更新 8月10日 13:12/);
  assert.match(html, /加载更多/);
  assert.match(html, /已显示 10\/25/);
  assert.match(html, /href="\/projects\?project_limit=20"/);
});

test('workbench explains that repeated history sync is non-destructive', () => {
  const project = { id: 'project_1', name: '示例项目', task_count: 3 };
  const html = homePage({
    projects: [project], selectedProject: project, tasks: [],
    syncNotice: { added: 0, message: '没有发现需要新增的项目；已有任务和沟通保持不变。' },
  });
  assert.match(html, /没有发现需要新增的项目/);
  assert.match(html, /已有任务和沟通保持不变/);
  assert.match(html, /action="\/projects\/sync"/);
});


test('workbench shows non-destructive project task sync results', () => {
  const project = { id: 'project_1', name: '示例项目', task_count: 3 };
  const html = homePage({
    projects: [project], selectedProject: project, tasks: [],
    taskSyncNotice: { added: 2, message: '新增 2 个历史任务；1 个会话已有任务。已有任务和沟通没有被修改。' },
  });
  assert.match(html, /新增 2 个历史任务/);
  assert.match(html, /已有任务和沟通没有被修改/);
  assert.match(html, /task-sync-notice success/);
});

test('project workbench lays out every task without opening details automatically', () => {
  const project = { id: 'project_1', name: '示例项目', task_count: 1 };
  const task = { id: 'task_1', project_id: 'project_1', project_name: '示例项目', title: '待选择任务', prompt: '内容', status: 'completed', phase: '已完成', created_at: '2026-08-09T01:00:00.000Z', result: { summary: '不应直接展示', completed_items: [], validation: [], risks: [], question: '' } };
  const html = homePage({ projects: [project], selectedProject: project, tasks: [task], selectedTask: null });
  assert.match(html, /task-board/);
  assert.match(html, /data-status="completed"[\s\S]*待选择任务/);
  assert.doesNotMatch(html, /board-task active/);
  assert.doesNotMatch(html, /task-detail-panel/);
  assert.doesNotMatch(html, /不应直接展示/);
});

test('projectPage distributes tasks into their matching status columns', () => {
  const project = { id: 'project_1', name: '示例项目', path: '/tmp/example' };
  const tasks = [
    { id: 'task_1', project_id: 'project_1', project_name: '示例项目', title: '修复测试', prompt: '内容', phase: '已完成', status: 'completed', created_at: '2026-08-09T00:00:00.000Z', result: { summary: '已修复', completed_items: [], validation: [], risks: [], question: '' } },
    { id: 'task_2', project_id: 'project_1', project_name: '示例项目', title: '等待测试', prompt: '内容', phase: '等待执行', status: 'queued', created_at: '2026-08-09T01:00:00.000Z' },
  ];
  const html = projectPage(project, tasks, [project, { id: 'project_2', name: '其他项目' }]);
  assert.match(html, /sidebar-project active/);
  assert.match(html, /data-status="queued"[\s\S]*等待测试/);
  assert.match(html, /data-status="completed"[\s\S]*修复测试/);
  assert.doesNotMatch(html, /board-task active/);
  assert.doesNotMatch(html, /class="result-hero/);
});

test('empty project still renders all status columns and offers a new task', () => {
  const project = { id: 'project_1', name: '空项目', path: '/tmp/empty' };
  const html = projectsPage({ projects: [project], selectedProject: project, tasks: [], selectedTask: null });
  assert.equal((html.match(/class="status-column"/g) || []).length, 7);
  assert.match(html, /暂无待执行任务/);
  assert.match(html, /\/tasks\/new\?project=project_1/);
});


test('task detail renders Markdown in prompts and results', () => {
  const project = { id: 'project_1', name: '示例项目' };
  const task = {
    id: 'task_markdown', project_id: project.id, project_name: project.name,
    title: 'Markdown 任务', prompt: '请检查 `src/app.js`', status: 'completed', phase: '已完成',
    created_at: '2026-08-09T01:00:00.000Z',
    result: { summary: '已完成\n\n```js\nconsole.log(1)\n```', completed_items: [], validation: [], risks: [], question: '' },
    runs: [{ id: 'run_markdown', sequence: 1, prompt: '请检查 `src/app.js`', status: 'completed', origin: 'done', created_at: '2026-08-09T01:00:00.000Z', result: { summary: '已完成\n\n- 检查通过', completed_items: [], validation: [], risks: [], question: '' } }],
  };
  const html = taskPage(task, [task], [project], project);
  assert.match(html, /请检查 <code>src\/app\.js<\/code>/);
  assert.match(html, /<pre><code>console\.log\(1\)<\/code><\/pre>/);
  assert.match(html, /<li>检查通过<\/li>/);
});

test('task detail folds historical runs and shows the latest context usage', () => {
  const project = { id: 'project_1', name: '示例项目' };
  const result = (summary) => ({ outcome: 'completed', summary, completed_items: [], validation: [], risks: [], question: '' });
  const task = {
    id: 'task_long', project_id: project.id, project_name: project.name,
    title: '多轮任务', prompt: '第一轮要求', status: 'completed', phase: '已完成',
    created_at: '2026-08-09T01:00:00.000Z', result: result('第三轮完成'),
    runs: [1, 2, 3].map((sequence) => ({
      id: `run_${sequence}`, sequence, prompt: `第 ${sequence} 轮要求`, status: 'completed', origin: 'done',
      created_at: `2026-08-09T0${sequence}:00:00.000Z`, result: result(`第 ${sequence} 轮完成`),
      ...(sequence === 3 ? { usage: {
        usage: { input_tokens: 1800, cache_read_input_tokens: 64000, cache_creation_input_tokens: 12000, output_tokens: 800 },
        totalCostUsd: 0.084, numTurns: 13,
        modelUsage: { 'claude-sonnet-4-6': { contextWindow: 200000 } },
      } } : {}),
    })),
  };
  const html = taskPage(task, [task], [project], project);
  const timelineHtml = html.slice(html.indexOf('class="panel task-timeline"'));
  assert.equal((timelineHtml.match(/class="task-run /g) || []).length, 3);
  assert.equal((timelineHtml.match(/class="task-run [^"]+" open/g) || []).length, 1);
  assert.ok(timelineHtml.indexOf('第 1 轮') < timelineHtml.indexOf('第 3 轮'));
  assert.match(timelineHtml, /第 1 轮[\s\S]*class="task-run completed" open[\s\S]*第 3 轮/);
  assert.match(html, /按沟通顺序展示，最近一轮默认展开/);
  assert.match(html, /第 3 轮 · 77\.8k \/ 200k/);
  assert.match(html, /缓存读取 64k/);
  assert.match(html, /自动压缩已开启/);
});

test('taskPage keeps its project and board task active and opens details', () => {
  const projects = [
    { id: 'project_1', name: '示例项目' },
    { id: 'project_2', name: '其他项目' },
  ];
  const selected = { id: 'task_1', project_id: 'project_1', project_name: '示例项目', title: '当前任务', prompt: '内容', status: 'completed', phase: '已完成', created_at: '2026-08-09T01:00:00.000Z', result: { summary: '完成', completed_items: [], validation: [], risks: [], question: '' } };
  const other = { ...selected, id: 'task_2', title: '同项目其他任务' };
  const html = taskPage(selected, [other, selected], projects, projects[0]);
  assert.match(html, /sidebar-project active[^>]*href="\/projects\/project_1"|href="\/projects\/project_1"[^>]*sidebar-project active/);
  assert.match(html, /board-task active[^>]*href="\/tasks\/task_1"|href="\/tasks\/task_1"[^>]*board-task active/);
  assert.match(html, /task-detail-panel/);
  assert.match(html, /执行结果/);
});


test('taskPage renders historical Claude envelope as a friendly failure', () => {
  const project = { id: 'project_1', name: '示例项目' };
  const envelope = JSON.stringify({ is_error: true, subtype: 'error_max_turns', terminal_reason: 'max_turns', errors: ['Reached maximum number of turns (30)'] });
  const selected = {
    id: 'task_failed', project_id: project.id, project_name: project.name,
    title: '失败任务', prompt: '验证工具', status: 'failed', phase: '未完成',
    created_at: '2026-08-09T01:00:00.000Z', error_message: envelope, raw_result: envelope,
    result: { outcome: 'failed', summary: envelope, completed_items: [], validation: [], risks: [], question: '' },
  };
  const html = taskPage(selected, [selected], [project], project);
  assert.match(html, /任务未能在本次执行中完成/);
  assert.match(html, /最大执行轮数（30 轮）/);
  assert.match(html, /这不是页面故障/);
  assert.doesNotMatch(html, /&quot;is_error&quot;/);
});


test('Claude history matches project path and keeps only user-facing messages', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-history-test-'));
  const project = { id: 'project_1', name: '示例项目', path: '/tmp/example' };
  const sessionId = 'session_project_1';
  const projectDir = path.join(claudeHome, 'projects', 'example');
  fs.mkdirSync(projectDir, { recursive: true });

  try {
    fs.writeFileSync(path.join(claudeHome, 'history.jsonl'), [
      JSON.stringify({ display: '请修复登录测试', timestamp: 1786240000000, project: project.path, sessionId }),
      JSON.stringify({ display: '不应属于当前项目', timestamp: 1786240001000, project: '/tmp/other', sessionId: 'session_other' }),
    ].join('\n'));
    fs.writeFileSync(path.join(projectDir, 'sessions-index.json'), JSON.stringify({
      originalPath: project.path,
      entries: [{
        sessionId,
        fullPath: path.join(projectDir, `${sessionId}.jsonl`),
        firstPrompt: '请修复登录测试',
        messageCount: 4,
        created: '2026-08-09T01:00:00.000Z',
        modified: '2026-08-09T01:05:00.000Z',
        projectPath: project.path,
      }],
    }));
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [
      JSON.stringify({ type: 'user', timestamp: '2026-08-09T01:00:00.000Z', message: { role: 'user', content: '请修复登录测试' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-08-09T01:01:00.000Z', message: { role: 'assistant', content: [
        { type: 'text', text: '我先检查相关代码。' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/example/login.js' } },
      ] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-08-09T01:02:00.000Z', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tool_1', content: '命令和文件输出不应展示' },
      ] } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-08-09T01:05:00.000Z', message: { role: 'assistant', content: [
        { type: 'text', text: '登录测试已经修复并通过。' },
      ] } }),
    ].join('\n'));

    const conversations = listProjectClaudeConversations(project, [], { claudeHome });
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].sessionId, sessionId);
    assert.equal(conversations[0].messageCount, 2);

    const detail = getProjectClaudeConversation(project, [], sessionId, { claudeHome });
    assert.deepEqual(detail.messages.map((message) => message.role), ['user', 'assistant']);
    assert.deepEqual(detail.messages.map((message) => message.text), ['请修复登录测试', '登录测试已经修复并通过。']);
    assert.doesNotMatch(JSON.stringify(detail), /tool_use|tool_result|命令和文件输出|我先检查/);
  } finally {
    fs.rmSync(claudeHome, { recursive: true, force: true });
  }
});

test('Claude history launched from a project subdirectory belongs to the root project', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-nested-history-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-project-root-'));
  const nested = path.join(root, 'packages', 'web');
  const sessionId = 'session_nested';
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(claudeHome, 'projects', 'nested'), { recursive: true });

  try {
    fs.writeFileSync(path.join(claudeHome, 'history.jsonl'), JSON.stringify({
      display: '更新前端页面', timestamp: 1786240000000, project: nested, sessionId,
    }));
    fs.writeFileSync(path.join(claudeHome, 'projects', 'nested', 'sessions-index.json'), JSON.stringify({
      originalPath: nested,
      entries: [{ sessionId, firstPrompt: '更新前端页面', projectPath: nested }],
    }));

    const conversations = listProjectClaudeConversations({ id: 'project_1', name: '根项目', path: root }, [], { claudeHome });
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].sessionId, sessionId);
  } finally {
    fs.rmSync(claudeHome, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Done task sessions show the structured result instead of execution chatter', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'done-history-test-'));
  const project = { id: 'project_1', name: '示例项目', path: '/tmp/example' };
  const sessionId = 'session_done';
  const projectDir = path.join(claudeHome, 'projects', 'worktree');
  const task = {
    id: 'task_1', project_id: project.id, title: '修复测试', prompt: '修复测试', status: 'completed',
    session_id: sessionId, created_at: '2026-08-09T01:00:00.000Z', updated_at: '2026-08-09T01:10:00.000Z',
    result: { summary: '修复已经完成', completed_items: ['测试通过'] },
  };
  fs.mkdirSync(projectDir, { recursive: true });

  try {
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '用户任务：\n修复测试\n执行要求：\n请执行' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '我正在检查端口和命令输出。' }] } }),
    ].join('\n'));

    const conversations = listProjectClaudeConversations(project, [task], { claudeHome });
    assert.equal(conversations[0].messageCount, 2);
    const detail = getProjectClaudeConversation(project, [task], sessionId, { claudeHome });
    assert.deepEqual(detail.messages.map((message) => message.role), ['user', 'assistant']);
    assert.match(detail.messages[0].text, /修复测试/);
    assert.match(detail.messages[1].text, /修复已经完成[\s\S]*测试通过/);
    assert.doesNotMatch(JSON.stringify(detail.messages), /正在检查端口|命令输出/);
  } finally {
    fs.rmSync(claudeHome, { recursive: true, force: true });
  }
});

test('Done task sessions remain visible when Claude history is unavailable', () => {
  const project = { id: 'project_1', name: '示例项目', path: '/tmp/example' };
  const task = {
    id: 'task_1', project_id: project.id, title: '历史任务', prompt: '修复测试', status: 'completed',
    session_id: 'session_missing', created_at: '2026-08-09T01:00:00.000Z', updated_at: '2026-08-09T01:10:00.000Z',
    result: { summary: '已完成' },
  };
  const conversations = listProjectClaudeConversations(project, [task], { claudeHome: '/tmp/claude-history-test-does-not-exist' });
  assert.equal(conversations.length, 1);
  const detail = getProjectClaudeConversation(project, [task], task.session_id, { claudeHome: '/tmp/claude-history-test-does-not-exist' });
  assert.deepEqual(detail.messages.map((message) => message.role), ['assistant']);
  assert.match(detail.messages[0].text, /已完成/);
});

test('linked historical tasks keep the original alternating Claude replies', () => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-history-test-'));
  const project = { id: 'project_1', name: '示例项目', path: '/tmp/linked-history-project' };
  const sessionId = 'session_linked_history';
  const projectDir = path.join(claudeHome, 'projects', 'linked');
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  const task = {
    id: 'task_history', project_id: project.id, title: '历史任务', prompt: '第一问', status: 'accepted',
    source_type: 'claude_history', session_id: sessionId, created_at: '2026-08-09T01:00:00.000Z',
    updated_at: '2026-08-09T01:10:00.000Z', result: { summary: '不应替换原始回复的旧结果' },
  };
  fs.mkdirSync(projectDir, { recursive: true });

  try {
    fs.writeFileSync(path.join(projectDir, 'sessions-index.json'), JSON.stringify({
      originalPath: project.path,
      entries: [{ sessionId, firstPrompt: '第一问', projectPath: project.path, fullPath: transcriptPath }],
    }));
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ uuid: 'u1', type: 'user', timestamp: '2026-08-09T01:00:00.000Z', message: { role: 'user', content: '第一问' } }),
      JSON.stringify({ uuid: 'a1', type: 'assistant', timestamp: '2026-08-09T01:01:00.000Z', message: { role: 'assistant', content: '第一答' } }),
      JSON.stringify({ uuid: 'u2', type: 'user', timestamp: '2026-08-09T01:02:00.000Z', message: { role: 'user', content: '第二问' } }),
      JSON.stringify({ uuid: 'a2', type: 'assistant', timestamp: '2026-08-09T01:03:00.000Z', message: { role: 'assistant', content: '第二答' } }),
    ].join('\n'));

    const detail = getProjectClaudeConversation(project, [task], sessionId, { claudeHome });
    assert.deepEqual(detail.messages.map((message) => message.text), ['第一问', '第一答', '第二问', '第二答']);
    assert.deepEqual(detail.messages.filter((message) => message.role === 'user').map((message) => message.sourceId), ['u1', 'u2']);
    assert.doesNotMatch(JSON.stringify(detail.messages), /不应替换原始回复的旧结果/);
  } finally {
    fs.rmSync(claudeHome, { recursive: true, force: true });
  }
});

test('task detail renders multiple runs as one result timeline and keeps follow-up available', () => {
  const project = { id: 'project_1', name: '示例项目' };
  const task = {
    id: 'task_multi', project_id: project.id, project_name: project.name,
    title: '持续改进页面', prompt: '先完成页面', status: 'accepted', phase: '已接受',
    session_id: 'session_multi', run_count: 2,
    created_at: '2026-08-09T01:00:00.000Z', updated_at: '2026-08-10T01:00:00.000Z',
    result: { outcome: 'completed', summary: '第二轮已经完成', completed_items: [], validation: [], risks: [], question: '' },
    runs: [
      {
        id: 'run_1', sequence: 1, prompt: '先完成页面', status: 'completed', origin: 'claude_history',
        created_at: '2026-08-09T01:00:00.000Z', completed_at: '2026-08-09T02:00:00.000Z',
        result: { outcome: 'completed', summary: '页面已经完成', completed_items: ['创建页面'], validation: [], risks: [], question: '' },
      },
      {
        id: 'run_2', sequence: 2, prompt: '按钮再小一点', status: 'completed', origin: 'done',
        created_at: '2026-08-10T00:00:00.000Z', completed_at: '2026-08-10T01:00:00.000Z',
        result: { outcome: 'completed', summary: '按钮已经调整', completed_items: [], validation: [], risks: [], question: '' },
      },
    ],
  };
  const html = taskPage(task, [task], [project], project);
  assert.match(html, /2 轮沟通/);
  assert.ok(html.indexOf('第 1 轮') < html.indexOf('第 2 轮'));
  assert.match(html, /第 1 轮[\s\S]*先完成页面[\s\S]*页面已经完成/);
  assert.match(html, /第 2 轮[\s\S]*按钮再小一点[\s\S]*按钮已经调整/);
  assert.match(html, /Claude Code 历史/);
  assert.match(html, />Done<\/span>/);
  assert.match(html, /action="\/tasks\/task_multi\/runs"/);
  assert.match(html, /追问或补充/);
  assert.doesNotMatch(html, /textarea[^>]*disabled/);
});

test('running task shows its timeline but disables another follow-up', () => {
  const project = { id: 'project_1', name: '示例项目' };
  const task = {
    id: 'task_running', project_id: project.id, project_name: project.name,
    title: '正在继续', prompt: '原始要求', status: 'running', phase: 'Claude 正在恢复之前的沟通',
    created_at: '2026-08-10T01:00:00.000Z', updated_at: '2026-08-10T01:05:00.000Z',
    runs: [{ id: 'run_1', sequence: 1, prompt: '原始要求', status: 'running', created_at: '2026-08-10T01:00:00.000Z' }],
  };
  const html = taskPage(task, [task], [project], project);
  assert.match(html, /当前轮正在执行/);
  assert.match(html, /textarea[^>]*disabled/);
  assert.match(html, /请等待当前轮结束/);
});

test('needs-input run highlights Claude question and accepts an answer', () => {
  const project = { id: 'project_1', name: '示例项目' };
  const result = { outcome: 'needs_input', summary: '需要确认颜色', completed_items: [], validation: [], risks: [], question: '主按钮应该使用绿色还是蓝色？' };
  const task = {
    id: 'task_question', project_id: project.id, project_name: project.name,
    title: '调整主题', prompt: '调整主题', status: 'needs_input', phase: '需要补充信息',
    created_at: '2026-08-10T01:00:00.000Z', updated_at: '2026-08-10T01:05:00.000Z', result,
    runs: [{ id: 'run_1', sequence: 1, prompt: '调整主题', status: 'needs_input', created_at: '2026-08-10T01:00:00.000Z', result }],
  };
  const html = taskPage(task, [task], [project], project);
  assert.match(html, /Claude 需要你补充/);
  assert.match(html, /主按钮应该使用绿色还是蓝色/);
  assert.match(html, /回答 Claude 的问题，或补充新的要求/);
  assert.doesNotMatch(html, /textarea[^>]*disabled/);
});

test('workspace removes the global topbar and keeps Done branding in the project sidebar', () => {
  const project = { id: 'project_1', name: '示例项目', task_count: 0 };
  const html = homePage({ projects: [project], selectedProject: project, tasks: [] });
  assert.doesNotMatch(html, /class="topbar"|class="simple-topbar"/);
  assert.match(html, /class="workspace-brand"[\s\S]*Done[\s\S]*<h1>项目<\/h1>/);
  assert.match(html, /class="shell workspace-shell"/);
});


test('standalone forms keep only a minimal Done navigation bar', () => {
  const html = newProjectPage();
  assert.match(html, /class="simple-topbar"/);
  assert.match(html, /返回工作台/);
  assert.doesNotMatch(html, /面向结果的软件任务执行工具|<nav>/);
});

test('workbench renders lightweight project search and keeps its query in navigation', () => {
  const project = { id: 'project_1', name: 'Claude 工具', path: '/tmp/claude-tool', task_count: 1 };
  const html = homePage({
    projects: [project], selectedProject: project, tasks: [],
    projectListMeta: {
      query: 'claude code', isSearching: true, totalCount: 1,
      searchAction: '/projects/project_1', clearHref: '/projects/project_1', hasMore: false,
    },
  });
  assert.match(html, /type="search"/);
  assert.match(html, /placeholder="搜索项目名称或路径"/);
  assert.match(html, /value="claude code"/);
  assert.match(html, /找到 1 个项目/);
  assert.match(html, /href="\/projects\/project_1\?q=claude\+code"/);
  assert.match(html, /aria-label="清空项目搜索"/);
  assert.match(html, /<script src="\/app\.js"><\/script>/);
});

test('workbench escapes project search queries and explains empty results', () => {
  const html = homePage({
    projects: [], selectedProject: { id: 'project_current', name: '当前项目' }, tasks: [],
    projectListMeta: {
      query: '<claude&', isSearching: true, totalCount: 0,
      searchAction: '/projects/project_current', clearHref: '/projects/project_current', hasMore: false,
    },
  });
  assert.match(html, /value="&lt;claude&amp;"/);
  assert.match(html, /没有找到相关项目/);
  assert.match(html, /清空搜索/);
  assert.match(html, /找到 0 个项目/);
});

test('workbench does not show a project search clear control without a query', () => {
  const html = homePage({
    projects: [], selectedProject: null, tasks: [],
    projectListMeta: { query: '', isSearching: false, totalCount: 0, searchAction: '/projects', hasMore: false },
  });
  assert.doesNotMatch(html, /aria-label="清空项目搜索"/);
  assert.match(html, /还没有项目/);
});

test('project and task headings expose lightweight rename forms and scoped feedback', () => {
  const project = { id: 'project_1', name: '示例 "项目"', updated_at: '2026-08-11T01:00:00.000Z' };
  const task = {
    id: 'task_1', project_id: project.id, project_name: project.name,
    title: '需要重命名的任务', prompt: '检查重命名页面', status: 'completed', phase: '已完成',
    created_at: '2026-08-11T01:00:00.000Z',
    result: { summary: '完成', completed_items: [], validation: [], risks: [], question: '' },
  };

  const projectHtml = homePage({
    projects: [project], selectedProject: project, tasks: [task],
    renameNotice: { target: 'project', error: false, message: '项目名称已更新。' },
  });
  assert.match(projectHtml, /action="\/projects\/project_1\/rename"/);
  assert.match(projectHtml, /name="name"/);
  assert.match(projectHtml, /maxlength="80"/);
  assert.match(projectHtml, /value="示例 &quot;项目&quot;"/);
  assert.match(projectHtml, /class="title-edit-row"><h1>示例 &quot;项目&quot;<\/h1><details class="rename-control">/);
  assert.match(projectHtml, /重命名项目/);
  assert.match(projectHtml, /rename-notice success[^>]*role="status"[^>]*>项目名称已更新/);

  const taskHtml = homePage({
    projects: [project], selectedProject: project, tasks: [task], selectedTask: task,
    renameNotice: { target: 'task', error: true, message: '<名称不能为空>' },
  });
  assert.match(taskHtml, /action="\/tasks\/task_1\/rename"/);
  assert.match(taskHtml, /name="title"/);
  assert.match(taskHtml, /maxlength="160"/);
  assert.match(taskHtml, /value="需要重命名的任务"/);
  assert.match(taskHtml, /class="title-edit-row"><h1>需要重命名的任务<\/h1><details class="rename-control">/);
  assert.match(taskHtml, /重命名任务/);
  assert.match(taskHtml, /rename-notice error[^>]*role="alert"[^>]*>&lt;名称不能为空&gt;/);
  assert.doesNotMatch(taskHtml, /rename-notice success/);
});
