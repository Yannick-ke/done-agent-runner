import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const dbModuleUrl = pathToFileURL(path.resolve('src/db.js')).href;

test('database migrates project update times and sorts projects and tasks by last update', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'done-db-test-'));
  const databasePath = path.join(dataDir, 'tasks.db');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_task_id TEXT, title TEXT NOT NULL,
      prompt TEXT NOT NULL, status TEXT NOT NULL, phase TEXT, session_id TEXT, branch_name TEXT,
      workspace_path TEXT, result_json TEXT, raw_result TEXT, diff_text TEXT, diff_stat TEXT,
      error_message TEXT, exit_code INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, accepted_at TEXT, updated_at TEXT NOT NULL
    );
    INSERT INTO projects (id, name, path, created_at)
      VALUES ('legacy', '旧项目', '/tmp/done-legacy', '2026-08-09T00:00:00.000Z');
    INSERT INTO tasks (id, project_id, title, prompt, status, created_at, updated_at)
      VALUES ('legacy-task', 'legacy', '旧任务', '旧内容', 'completed',
        '2026-08-09T01:00:00.000Z', '2026-08-09T02:00:00.000Z');
  `);
  legacy.close();

  const script = `
    import assert from 'node:assert/strict';
    const db = await import(${JSON.stringify(dbModuleUrl)});
    assert.equal(db.getProject('legacy').updated_at, '2026-08-09T02:00:00.000Z');

    const project = db.createProject({ name: '新项目', projectPath: '/tmp/done-new' });
    const taskA = db.createTask({ projectId: project.id, prompt: '更新时间较新的任务' });
    const latestProjectUpdate = db.getProject(project.id).updated_at;
    db.updateTask(taskA.id, { status: 'completed', phase: '已完成', updated_at: '2026-08-10T01:00:00.000Z' });
    const taskB = db.createTask({ projectId: project.id, prompt: '更新时间较旧的任务' });
    const latestAfterCreate = db.getProject(project.id).updated_at;
    db.updateTask(taskB.id, { updated_at: '2026-08-09T23:00:00.000Z' });

    assert.deepEqual(db.listTasksByProject(project.id).map((task) => task.id), [taskA.id, taskB.id]);
    assert.equal(db.getProject(project.id).updated_at, latestAfterCreate);
    assert.ok(latestAfterCreate >= latestProjectUpdate);
    assert.equal(db.listProjects()[0].id, project.id);
    db.closeDb();
  `;
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: dataDir, DATABASE_PATH: databasePath },
    encoding: 'utf8',
  });

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('task runs migrate existing tasks and keep follow-ups on one task card', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'done-task-runs-test-'));
  const databasePath = path.join(dataDir, 'tasks.db');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_task_id TEXT, title TEXT NOT NULL,
      prompt TEXT NOT NULL, status TEXT NOT NULL, phase TEXT, session_id TEXT, branch_name TEXT,
      workspace_path TEXT, result_json TEXT, raw_result TEXT, diff_text TEXT, diff_stat TEXT,
      error_message TEXT, exit_code INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, accepted_at TEXT, updated_at TEXT NOT NULL
    );
    INSERT INTO projects VALUES (
      'legacy-project', '旧项目', '/tmp/done-runs-legacy',
      '2026-08-09T00:00:00.000Z', '2026-08-09T02:00:00.000Z'
    );
    INSERT INTO tasks (
      id, project_id, title, prompt, status, phase, session_id, result_json,
      created_at, completed_at, updated_at
    ) VALUES (
      'legacy-task', 'legacy-project', '旧任务', '旧的用户要求', 'completed', '已完成',
      'legacy-session', '{"outcome":"completed","summary":"旧结果"}',
      '2026-08-09T01:00:00.000Z', '2026-08-09T02:00:00.000Z', '2026-08-09T02:00:00.000Z'
    );
  `);
  legacy.close();

  const script = `
    import assert from 'node:assert/strict';
    const db = await import(${JSON.stringify(dbModuleUrl)});

    const migrated = db.listTaskRuns('legacy-task');
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].sequence, 1);
    assert.equal(migrated[0].prompt, '旧的用户要求');
    assert.equal(migrated[0].result.summary, '旧结果');

    const project = db.createProject({ name: '多轮项目', projectPath: '/tmp/done-task-runs-new' });
    const task = db.createTask({ projectId: project.id, prompt: '实现一个轻量页面' });
    assert.equal(db.listTasksByProject(project.id).length, 1);
    assert.deepEqual(db.listTaskRuns(task.id).map((run) => [run.sequence, run.status]), [[1, 'queued']]);

    const firstRun = db.getPendingTaskRun(task.id);
    db.updateTaskRun(firstRun.id, {
      status: 'completed', session_id: 'session-one',
      result_json: JSON.stringify({ outcome: 'completed', summary: '第一轮完成' }),
      usage_json: JSON.stringify({
        usage: { input_tokens: 1000, output_tokens: 500 },
        totalCostUsd: 0.01,
        numTurns: 2,
      }),
      completed_at: '2026-08-10T01:00:00.000Z',
    });
    assert.equal(db.getTaskRun(firstRun.id).usage.totalCostUsd, 0.01);
    assert.equal(db.listTaskRuns(task.id)[0].usage.numTurns, 2);
    db.updateTask(task.id, {
      status: 'completed', phase: '已完成', session_id: 'session-one',
      result_json: JSON.stringify({ outcome: 'completed', summary: '第一轮完成' }),
      completed_at: '2026-08-10T01:00:00.000Z',
    });

    const followUp = db.createTaskRun({ taskId: task.id, prompt: '按钮再小一点，并解释原因' });
    assert.equal(followUp.sequence, 2);
    assert.equal(db.listTasksByProject(project.id).length, 1);
    assert.equal(db.getTask(task.id).status, 'queued');
    assert.equal(db.getTask(task.id).session_id, 'session-one');
    assert.deepEqual(db.listTaskRuns(task.id).map((run) => [run.sequence, run.prompt]), [
      [1, '实现一个轻量页面'],
      [2, '按钮再小一点，并解释原因'],
    ]);

    assert.throws(
      () => db.createTaskRun({ taskId: task.id, prompt: '执行中不应重复追加' }),
      /当前任务仍在执行/,
    );

    const imported = db.createImportedTask({
      projectId: project.id, title: '历史会话', prompt: '历史要求', sessionId: 'history-session',
      result: { outcome: 'completed', summary: '历史结果' },
      createdAt: '2026-08-08T01:00:00.000Z', completedAt: '2026-08-08T02:00:00.000Z',
    });
    assert.equal(db.listTaskRuns(imported.id).length, 1);
    assert.equal(db.listTaskRuns(imported.id)[0].result.summary, '历史结果');
    db.closeDb();
  `;
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: dataDir, DATABASE_PATH: databasePath },
    encoding: 'utf8',
  });

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('task run details can backfill latest usage from the Claude result artifact', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'done-task-usage-artifact-test-'));
  const databasePath = path.join(dataDir, 'tasks.db');
  const workspaceRoot = path.join(dataDir, 'task', 'workspace');
  fs.mkdirSync(path.dirname(workspaceRoot), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(workspaceRoot), 'claude-result.json'), JSON.stringify({
    usage: { input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 300 },
    total_cost_usd: 0.12, num_turns: 5,
    modelUsage: { 'claude-sonnet-4-6': { contextWindow: 200000 } },
  }));
  const script = `
    import assert from 'node:assert/strict';
    const db = await import(${JSON.stringify(dbModuleUrl)});
    const project = db.createProject({ name: '用量项目', projectPath: ${JSON.stringify(path.join(dataDir, 'project'))} });
    const task = db.createTask({ projectId: project.id, prompt: '读取执行结果用量' });
    db.updateTask(task.id, { status: 'completed', workspace_path: ${JSON.stringify(workspaceRoot)} });
    const run = db.getPendingTaskRun(task.id);
    db.updateTaskRun(run.id, { status: 'completed' });
    const hydrated = db.listTaskRuns(task.id);
    assert.equal(hydrated[0].usage.totalCostUsd, 0.12);
    assert.equal(db.getTaskRun(run.id).usage.numTurns, 5);
    db.closeDb();
  `;
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '--eval', script], {
    cwd: process.cwd(), env: { ...process.env, DATA_DIR: dataDir, DATABASE_PATH: databasePath }, encoding: 'utf8',
  });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('project search matches names and paths across the full sorted project list', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'done-project-search-test-'));
  const databasePath = path.join(dataDir, 'tasks.db');
  const script = `
    import assert from 'node:assert/strict';
    const db = await import(${JSON.stringify(dbModuleUrl)});

    const byName = db.createProject({ name: 'Claude Dashboard', projectPath: '/tmp/done-search-dashboard' });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    const byPath = db.createProject({ name: '执行平台', projectPath: '/tmp/Claude-Worker' });
    db.createProject({ name: '无关项目', projectPath: '/tmp/done-search-unrelated' });
    db.createProject({ name: '100% Literal', projectPath: '/tmp/done-search-percent' });

    assert.deepEqual(db.listProjects('CLAUDE').map((project) => project.id), [byPath.id, byName.id]);
    assert.deepEqual(db.listProjects('执行').map((project) => project.id), [byPath.id]);
    assert.equal(db.listProjects('%').at(0).name, '100% Literal');
    assert.equal(db.listProjects('missing').length, 0);
    assert.equal(db.listProjects('  ').length, 4);
    db.closeDb();
  `;
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: dataDir, DATABASE_PATH: databasePath },
    encoding: 'utf8',
  });

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('historical task turns sync incrementally without duplicating or overwriting Done runs', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'done-incremental-history-test-'));
  const databasePath = path.join(dataDir, 'tasks.db');
  const claudeHome = path.join(dataDir, '.claude-empty');
  fs.mkdirSync(claudeHome, { recursive: true });
  const script = `
    import assert from 'node:assert/strict';
    const db = await import(${JSON.stringify(dbModuleUrl)});
    const service = await import(${JSON.stringify(pathToFileURL(path.resolve('src/task-sync-service.js')).href)});
    const result = (summary) => ({ outcome: 'accepted', summary, completed_items: [], validation: [], risks: [], question: '' });
    const turns = [
      { sourceKey: 'source-1', prompt: '第一问', result: result('第一答'), createdAt: '2026-08-10T01:00:00.000Z', completedAt: '2026-08-10T01:01:00.000Z' },
      { sourceKey: 'source-2', prompt: '第二问', result: result('第二答'), createdAt: '2026-08-10T01:02:00.000Z', completedAt: '2026-08-10T01:03:00.000Z' },
    ];
    const project = db.createProject({ name: '增量同步', projectPath: '/tmp/done-incremental-history' });
    const imported = db.createImportedTask({
      projectId: project.id, title: '历史会话', sessionId: 'history-session', turns,
      sourceUpdatedAt: '2026-08-10T01:03:00.000Z',
    });
    assert.equal(imported.source_type, 'claude_history');
    assert.deepEqual(db.listTaskRuns(imported.id).map((run) => [run.origin, run.source_key]), [
      ['claude_history', 'source-1'], ['claude_history', 'source-2'],
    ]);

    const unchanged = db.syncImportedTaskTurns({
      taskId: imported.id, sessionId: 'history-session', turns,
      sourceUpdatedAt: '2026-08-10T01:03:00.000Z',
    });
    assert.equal(unchanged.addedRuns.length, 0);
    assert.equal(db.listTaskRuns(imported.id).length, 2);

    const third = { sourceKey: 'source-3', prompt: '第三问', result: result('第三答'), createdAt: '2026-08-10T01:04:00.000Z', completedAt: '2026-08-10T01:05:00.000Z' };
    const increment = db.syncImportedTaskTurns({
      taskId: imported.id, sessionId: 'history-session', turns: [...turns, third],
      sourceUpdatedAt: third.completedAt,
    });
    assert.equal(increment.addedRuns.length, 1);
    assert.equal(db.getTask(imported.id).result.summary, '第三答');

    const doneRun = db.createTaskRun({ taskId: imported.id, prompt: 'Done 中的追问' });
    db.updateTaskRun(doneRun.id, {
      status: 'accepted', session_id: 'history-session', started_at: doneRun.created_at,
      completed_at: doneRun.created_at, result_json: JSON.stringify(result('Done 中保留的结果')),
    });
    db.updateTask(imported.id, {
      status: 'accepted', phase: '已接受', session_id: 'history-session',
      completed_at: doneRun.created_at, accepted_at: doneRun.created_at,
      result_json: JSON.stringify(result('Done 中保留的结果')),
    });
    const mirrored = {
      sourceKey: 'source-done', prompt: 'Done 中的追问', result: result('外部记录中的同轮结果'),
      createdAt: doneRun.created_at, completedAt: doneRun.created_at,
    };
    const protectedDone = db.syncImportedTaskTurns({
      taskId: imported.id, sessionId: 'history-session', turns: [...turns, third, mirrored],
      sourceUpdatedAt: doneRun.created_at,
    });
    assert.equal(protectedDone.addedRuns.length, 0);
    const finalRuns = db.listTaskRuns(imported.id);
    assert.equal(finalRuns.length, 4);
    assert.equal(finalRuns.at(-1).origin, 'done');
    assert.equal(finalRuns.at(-1).source_key, 'source-done');
    assert.equal(finalRuns.at(-1).result.summary, 'Done 中保留的结果');
    assert.equal(db.getTask(imported.id).result.summary, 'Done 中保留的结果');

    const ordinary = db.createTask({ projectId: project.id, prompt: '普通 Done 任务' });
    const ordinaryRun = db.getPendingTaskRun(ordinary.id);
    db.updateTaskRun(ordinaryRun.id, { status: 'accepted', session_id: 'ordinary-session', started_at: ordinaryRun.created_at, completed_at: ordinaryRun.created_at, result_json: JSON.stringify(result('普通结果')) });
    db.updateTask(ordinary.id, { status: 'accepted', phase: '已接受', session_id: 'ordinary-session', result_json: JSON.stringify(result('普通结果')) });
    const ordinarySync = db.syncImportedTaskTurns({ taskId: ordinary.id, sessionId: 'ordinary-session', turns: [{ ...turns[0], sourceKey: 'ordinary-source' }] });
    assert.equal(ordinarySync.protected, true);
    assert.equal(db.getTask(ordinary.id).source_type, null);

    for (const trigger of ['manual', 'scheduled', 'webhook']) {
      const serviceResult = service.syncProjectHistoryTasks({ projectId: project.id, trigger, options: { claudeHome: ${JSON.stringify(claudeHome)} } });
      assert.equal(serviceResult.trigger, trigger);
    }
    assert.throws(() => service.syncProjectHistoryTasks({ projectId: project.id, trigger: 'other', options: { claudeHome: ${JSON.stringify(claudeHome)} } }), /不支持的同步触发方式/);
    db.closeDb();
  `;
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: dataDir, DATABASE_PATH: databasePath },
    encoding: 'utf8',
  });

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('legacy imported history task is upgraded while an executed Done task stays protected', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'done-legacy-history-upgrade-test-'));
  const databasePath = path.join(dataDir, 'tasks.db');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_task_id TEXT, title TEXT NOT NULL,
      prompt TEXT NOT NULL, status TEXT NOT NULL, phase TEXT, session_id TEXT, branch_name TEXT,
      workspace_path TEXT, result_json TEXT, raw_result TEXT, diff_text TEXT, diff_stat TEXT,
      error_message TEXT, exit_code INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, accepted_at TEXT, updated_at TEXT NOT NULL
    );
    INSERT INTO projects VALUES ('project-1', '旧历史项目', '/tmp/done-legacy-history', '2026-08-09T00:00:00.000Z', '2026-08-09T02:00:00.000Z');
    INSERT INTO tasks (
      id, project_id, title, prompt, status, phase, session_id, result_json,
      created_at, completed_at, accepted_at, updated_at
    ) VALUES (
      'legacy-history', 'project-1', '历史任务', '第一问', 'accepted', '已接受', 'legacy-session',
      '{"outcome":"accepted","summary":"旧同步时错误折叠的最后结果"}',
      '2026-08-09T01:00:00.000Z', '2026-08-09T01:05:00.000Z', '2026-08-09T01:05:00.000Z', '2026-08-09T02:00:00.000Z'
    );
  `);
  legacy.close();

  const script = `
    import assert from 'node:assert/strict';
    const db = await import(${JSON.stringify(dbModuleUrl)});
    const result = (summary) => ({ outcome: 'accepted', summary, completed_items: [], validation: [], risks: [], question: '' });
    const sync = db.syncImportedTaskTurns({
      taskId: 'legacy-history', sessionId: 'legacy-session',
      turns: [
        { sourceKey: 'legacy-1', prompt: '第一问', result: result('第一答'), createdAt: '2026-08-09T01:00:00.000Z', completedAt: '2026-08-09T01:01:00.000Z' },
        { sourceKey: 'legacy-2', prompt: '第二问', result: result('第二答'), createdAt: '2026-08-09T01:02:00.000Z', completedAt: '2026-08-09T01:03:00.000Z' },
      ],
      sourceUpdatedAt: '2026-08-09T01:03:00.000Z',
    });
    assert.equal(sync.migratedLegacy, true);
    assert.equal(sync.addedRuns.length, 1);
    assert.equal(db.getTask('legacy-history').source_type, 'claude_history');
    assert.deepEqual(db.listTaskRuns('legacy-history').map((run) => [run.origin, run.source_key, run.result.summary]), [
      ['claude_history', 'legacy-1', '第一答'],
      ['claude_history', 'legacy-2', '第二答'],
    ]);
    db.closeDb();
  `;
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: dataDir, DATABASE_PATH: databasePath },
    encoding: 'utf8',
  });

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('project and task names can be renamed without changing their identity', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'done-rename-test-'));
  const databasePath = path.join(dataDir, 'tasks.db');
  const script = `
    import assert from 'node:assert/strict';
    const db = await import(${JSON.stringify(dbModuleUrl)});

    const project = db.createProject({ name: '旧项目名称', projectPath: '/tmp/done-rename-project' });
    const task = db.createTask({ projectId: project.id, prompt: '实现项目和任务重命名功能' });
    const originalTitle = task.title;

    await new Promise((resolve) => setTimeout(resolve, 5));
    const renamedProject = db.renameProject(project.id, '  新项目名称  ');
    assert.equal(renamedProject.id, project.id);
    assert.equal(renamedProject.path, project.path);
    assert.equal(renamedProject.name, '新项目名称');
    assert.ok(renamedProject.updated_at > project.updated_at);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const renamedTask = db.renameTask(task.id, '  新任务名称  ');
    assert.equal(renamedTask.id, task.id);
    assert.equal(renamedTask.project_id, project.id);
    assert.equal(renamedTask.prompt, task.prompt);
    assert.notEqual(renamedTask.title, originalTitle);
    assert.equal(renamedTask.title, '新任务名称');
    assert.ok(renamedTask.updated_at > task.updated_at);
    assert.equal(db.getProject(project.id).updated_at, renamedTask.updated_at);

    assert.throws(() => db.renameProject(project.id, '   '), /项目名称不能为空/);
    assert.throws(() => db.renameProject(project.id, '项'.repeat(81)), /不能超过 80 个字符/);
    assert.throws(() => db.renameTask(task.id, ''), /任务名称不能为空/);
    assert.throws(() => db.renameTask(task.id, '任'.repeat(161)), /不能超过 160 个字符/);
    assert.equal(db.renameProject('missing-project', '名称'), null);
    assert.equal(db.renameTask('missing-task', '名称'), null);
    db.closeDb();
  `;
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: dataDir, DATABASE_PATH: databasePath },
    encoding: 'utf8',
  });

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
