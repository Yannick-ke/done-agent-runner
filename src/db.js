import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { makeId, normalizeTask, normalizeTaskRun, nowIso, taskTitle } from './utils.js';

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
const db = new DatabaseSync(config.databasePath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    phase TEXT,
    session_id TEXT,
    source_type TEXT,
    source_updated_at TEXT,
    source_last_synced_at TEXT,
    branch_name TEXT,
    workspace_path TEXT,
    result_json TEXT,
    raw_result TEXT,
    diff_text TEXT,
    diff_stat TEXT,
    error_message TEXT,
    exit_code INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    accepted_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    result_json TEXT,
    raw_result TEXT,
    error_message TEXT,
    exit_code INTEGER,
    session_id TEXT,
    usage_json TEXT,
    origin TEXT NOT NULL DEFAULT 'done',
    source_key TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(task_id, sequence)
  );

  CREATE INDEX IF NOT EXISTS tasks_status_created_idx ON tasks(status, created_at);
  CREATE INDEX IF NOT EXISTS tasks_project_updated_idx ON tasks(project_id, updated_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS tasks_project_session_unique_idx
    ON tasks(project_id, session_id) WHERE session_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS task_runs_task_created_idx ON task_runs(task_id, sequence ASC);
  CREATE INDEX IF NOT EXISTS task_runs_status_created_idx ON task_runs(status, created_at ASC);
`);

const taskColumns = db.prepare('PRAGMA table_info(tasks)').all();
if (!taskColumns.some((column) => column.name === 'source_type')) db.exec('ALTER TABLE tasks ADD COLUMN source_type TEXT;');
if (!taskColumns.some((column) => column.name === 'source_updated_at')) db.exec('ALTER TABLE tasks ADD COLUMN source_updated_at TEXT;');
if (!taskColumns.some((column) => column.name === 'source_last_synced_at')) db.exec('ALTER TABLE tasks ADD COLUMN source_last_synced_at TEXT;');
const taskRunColumns = db.prepare('PRAGMA table_info(task_runs)').all();
if (!taskRunColumns.some((column) => column.name === 'usage_json')) db.exec('ALTER TABLE task_runs ADD COLUMN usage_json TEXT;');
if (!taskRunColumns.some((column) => column.name === 'origin')) db.exec("ALTER TABLE task_runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'done';");
if (!taskRunColumns.some((column) => column.name === 'source_key')) db.exec('ALTER TABLE task_runs ADD COLUMN source_key TEXT;');
db.exec(`
  UPDATE task_runs SET origin = 'done' WHERE origin IS NULL OR origin = '';
  CREATE UNIQUE INDEX IF NOT EXISTS task_runs_source_key_unique_idx
    ON task_runs(task_id, source_key) WHERE source_key IS NOT NULL;
`);

const projectColumns = db.prepare('PRAGMA table_info(projects)').all();
if (!projectColumns.some((column) => column.name === 'updated_at')) {
  db.exec('ALTER TABLE projects ADD COLUMN updated_at TEXT;');
}
const projectTaskIndex = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'tasks_project_created_idx'").get();
if (projectTaskIndex?.sql && !projectTaskIndex.sql.includes('updated_at')) {
  db.exec('DROP INDEX tasks_project_created_idx;');
}
db.exec(`
  UPDATE projects
  SET updated_at = COALESCE(
    (SELECT MAX(t.updated_at) FROM tasks t WHERE t.project_id = projects.id),
    created_at
  )
  WHERE updated_at IS NULL OR updated_at = '';
  CREATE INDEX IF NOT EXISTS projects_updated_idx ON projects(updated_at DESC);
`);

// Existing installations only stored the latest result on tasks. Preserve that history as run 1.
const tasksWithoutRuns = db.prepare(`
  SELECT t.* FROM tasks t
  WHERE NOT EXISTS (SELECT 1 FROM task_runs r WHERE r.task_id = t.id)
`).all();
const insertMigratedRun = db.prepare(`
  INSERT INTO task_runs (
    id, task_id, sequence, prompt, status, result_json, raw_result, error_message,
    exit_code, session_id, created_at, started_at, completed_at, updated_at
  ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
for (const task of tasksWithoutRuns) {
  insertMigratedRun.run(
    makeId('run'), task.id, task.prompt, task.status, task.result_json, task.raw_result,
    task.error_message, task.exit_code, task.session_id, task.created_at,
    task.started_at, task.completed_at, task.updated_at,
  );
}

function touchProject(projectId, updatedAt = nowIso()) {
  db.prepare(`
    UPDATE projects
    SET updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
    WHERE id = ?
  `).run(updatedAt, updatedAt, projectId);
}

function insertTaskRun({ taskId, sequence, prompt, status, resultJson = null, rawResult = null, errorMessage = null, exitCode = null, sessionId = null, usageJson = null, origin = 'done', sourceKey = null, createdAt, startedAt = null, completedAt = null, updatedAt }) {
  const run = {
    id: makeId('run'), task_id: taskId, sequence, prompt, status,
    result_json: resultJson, raw_result: rawResult, error_message: errorMessage,
    exit_code: exitCode, session_id: sessionId, usage_json: usageJson, origin, source_key: sourceKey,
    created_at: createdAt, started_at: startedAt, completed_at: completedAt, updated_at: updatedAt,
  };
  db.prepare(`
    INSERT INTO task_runs (
      id, task_id, sequence, prompt, status, result_json, raw_result, error_message,
      exit_code, session_id, usage_json, origin, source_key, created_at, started_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id, run.task_id, run.sequence, run.prompt, run.status, run.result_json,
    run.raw_result, run.error_message, run.exit_code, run.session_id,
    run.usage_json, run.origin, run.source_key, run.created_at, run.started_at,
    run.completed_at, run.updated_at,
  );
  return getTaskRun(run.id);
}

export function createProject({ name, projectPath }) {
  const now = nowIso();
  const project = { id: makeId('project'), name: name.trim(), path: projectPath, created_at: now, updated_at: now };
  db.prepare('INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(project.id, project.name, project.path, project.created_at, project.updated_at);
  return project;
}

function renameValue(value, label, maxLength) {
  const name = String(value ?? '').trim();
  if (!name) throw new Error(`${label}不能为空。`);
  if (name.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符。`);
  return name;
}

export function renameProject(id, name) {
  const project = getProject(id);
  if (!project) return null;
  const nextName = renameValue(name, '项目名称', 80);
  const updatedAt = nowIso();
  db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(nextName, updatedAt, id);
  return getProject(id);
}


export function listProjects(query = '') {
  const normalizedQuery = String(query || '').trim();
  const filter = normalizedQuery
    ? `WHERE instr(lower(p.name), lower(?)) > 0
        OR instr(lower(p.path), lower(?)) > 0`
    : '';
  const statement = db.prepare(`
    SELECT p.*,
      COUNT(t.id) AS task_count,
      SUM(CASE WHEN t.status IN ('queued', 'running') THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN t.status IN ('completed', 'accepted') THEN 1 ELSE 0 END) AS completed_count,
      SUM(CASE WHEN t.status IN ('needs_input', 'failed') THEN 1 ELSE 0 END) AS attention_count,
      MAX(t.updated_at) AS last_task_updated_at
    FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
    ${filter}
    GROUP BY p.id ORDER BY p.updated_at DESC, p.created_at DESC
  `);
  return normalizedQuery ? statement.all(normalizedQuery, normalizedQuery) : statement.all();
}

export function listTasksByProject(projectId) {
  return db.prepare(`
    SELECT t.*, p.name AS project_name, p.path AS project_path,
      (SELECT COUNT(*) FROM task_runs r WHERE r.task_id = t.id) AS run_count
    FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.project_id = ?
    ORDER BY t.updated_at DESC, t.created_at DESC
  `).all(projectId).map(normalizeTask);
}

export function getProject(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) || null;
}

function importedResult(reply) {
  return {
    outcome: 'accepted',
    summary: String(reply || '').trim() || '已导入 Claude Code 历史会话，暂无可提取的最终结果。',
    completed_items: [],
    validation: [],
    risks: [],
    question: '',
  };
}

function normalizeImportedTurns({ turns = [], prompt, result, sessionId, createdAt, completedAt }) {
  if (turns.length) return turns.map((turn, index) => ({
    sourceKey: turn.sourceKey || `claude:${sessionId || 'unknown'}:${index + 1}`,
    prompt: String(turn.prompt || '').trim(),
    result: turn.result || importedResult(turn.reply),
    createdAt: turn.createdAt || createdAt || nowIso(),
    completedAt: turn.completedAt || completedAt || turn.createdAt || createdAt || nowIso(),
  })).filter((turn) => turn.prompt);
  const fallbackPrompt = String(prompt || '').trim();
  if (!fallbackPrompt) return [];
  return [{
    sourceKey: `claude:${sessionId || 'unknown'}:legacy`,
    prompt: fallbackPrompt,
    result: result || importedResult(''),
    createdAt: createdAt || nowIso(),
    completedAt: completedAt || createdAt || nowIso(),
  }];
}

export function createImportedTask({
  projectId, title, prompt, sessionId, result, turns = [], createdAt, completedAt, acceptedAt,
  sourceUpdatedAt,
}) {
  const now = nowIso();
  const importedTurns = normalizeImportedTurns({ turns, prompt, result, sessionId, createdAt, completedAt });
  if (!importedTurns.length) return null;
  const firstTurn = importedTurns[0];
  const lastTurn = importedTurns.at(-1);
  const created = createdAt || firstTurn.createdAt || now;
  const completed = completedAt || lastTurn.completedAt || created;
  const accepted = acceptedAt || completed;
  const resultJson = JSON.stringify(lastTurn.result || result || {});
  const task = {
    id: makeId('task'), project_id: projectId, parent_task_id: null,
    title: String(title || taskTitle(firstTurn.prompt)).trim().slice(0, 160) || taskTitle(firstTurn.prompt),
    prompt: firstTurn.prompt, status: 'accepted', phase: '已接受', session_id: sessionId,
    source_type: 'claude_history', source_updated_at: sourceUpdatedAt || completed,
    source_last_synced_at: now, result_json: resultJson, created_at: created,
    completed_at: completed, accepted_at: accepted, updated_at: now,
  };
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      INSERT INTO tasks (
        id, project_id, parent_task_id, title, prompt, status, phase, session_id,
        source_type, source_updated_at, source_last_synced_at, result_json,
        created_at, completed_at, accepted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, task.project_id, task.parent_task_id, task.title, task.prompt, task.status,
      task.phase, task.session_id, task.source_type, task.source_updated_at,
      task.source_last_synced_at, task.result_json, task.created_at, task.completed_at,
      task.accepted_at, task.updated_at,
    );
    importedTurns.forEach((turn, index) => insertTaskRun({
      taskId: task.id, sequence: index + 1, prompt: turn.prompt, status: 'accepted',
      resultJson: JSON.stringify(turn.result || {}), sessionId, origin: 'claude_history',
      sourceKey: turn.sourceKey, createdAt: turn.createdAt, completedAt: turn.completedAt,
      updatedAt: now,
    }));
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  const imported = getTask(task.id);
  touchProject(projectId, now);
  return imported;
}

function isLegacyImportedTask(task, runs, sessionId) {
  const firstRun = runs[0];
  return !task.source_type
    && task.session_id === sessionId
    && task.status === 'accepted'
    && task.phase === '已接受'
    && Number(task.attempts || 0) === 0
    && !task.workspace_path
    && !task.branch_name
    && !task.diff_text
    && firstRun?.sequence === 1
    && firstRun.status === 'accepted'
    && !firstRun.started_at
    && firstRun.prompt === task.prompt;
}

function datesAreClose(left, right, toleranceMs = 5 * 60 * 1000) {
  const leftTime = Date.parse(left || '');
  const rightTime = Date.parse(right || '');
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && Math.abs(leftTime - rightTime) <= toleranceMs;
}

function runPhase(status) {
  return {
    accepted: '已接受', completed: '已完成', needs_input: '需要补充',
    failed: '未完成', canceled: '已取消', queued: '等待执行', running: '执行中',
  }[status] || status;
}

export function syncImportedTaskTurns({ taskId, sessionId, turns = [], sourceUpdatedAt }) {
  const task = getTask(taskId);
  if (!task || task.session_id !== sessionId) return { task, addedRuns: [], protected: true, migratedLegacy: false };

  const initialRuns = listTaskRuns(taskId);
  const migratedLegacy = isLegacyImportedTask(task, initialRuns, sessionId);
  if (task.source_type !== 'claude_history' && !migratedLegacy) {
    return { task, addedRuns: [], protected: true, migratedLegacy: false };
  }

  const now = nowIso();
  const importedTurns = normalizeImportedTurns({ turns, sessionId });
  const addedRuns = [];
  db.exec('BEGIN IMMEDIATE;');
  try {
    let runs = initialRuns;
    if (migratedLegacy && importedTurns[0]) {
      const firstTurn = importedTurns[0];
      db.prepare(`
        UPDATE task_runs SET prompt = ?, status = 'accepted', result_json = ?, raw_result = NULL,
          error_message = NULL, exit_code = NULL, session_id = ?, origin = 'claude_history',
          source_key = ?, created_at = ?, started_at = NULL, completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        firstTurn.prompt, JSON.stringify(firstTurn.result || {}), sessionId, firstTurn.sourceKey,
        firstTurn.createdAt, firstTurn.completedAt, now, runs[0].id,
      );
      runs = listTaskRuns(taskId);
    }

    const knownSourceKeys = new Set(runs.map((run) => run.source_key).filter(Boolean));
    let nextSequence = runs.reduce((maximum, run) => Math.max(maximum, run.sequence), 0) + 1;
    for (const turn of importedTurns) {
      if (knownSourceKeys.has(turn.sourceKey)) continue;

      const matchingDoneRun = runs.find((run) => run.origin === 'done'
        && !run.source_key
        && run.prompt.trim() === turn.prompt.trim()
        && (!run.session_id || run.session_id === sessionId)
        && datesAreClose(run.created_at, turn.createdAt));
      if (matchingDoneRun) {
        db.prepare('UPDATE task_runs SET source_key = ? WHERE id = ?').run(turn.sourceKey, matchingDoneRun.id);
        knownSourceKeys.add(turn.sourceKey);
        matchingDoneRun.source_key = turn.sourceKey;
        continue;
      }

      const run = insertTaskRun({
        taskId, sequence: nextSequence, prompt: turn.prompt, status: 'accepted',
        resultJson: JSON.stringify(turn.result || {}), sessionId, origin: 'claude_history',
        sourceKey: turn.sourceKey, createdAt: turn.createdAt, completedAt: turn.completedAt,
        updatedAt: now,
      });
      addedRuns.push(run);
      runs.push(run);
      knownSourceKeys.add(turn.sourceKey);
      nextSequence += 1;
    }

    const changed = migratedLegacy || addedRuns.length > 0;
    const sourceUpdated = sourceUpdatedAt || importedTurns.at(-1)?.completedAt || task.source_updated_at || null;
    if (changed) {
      const allRuns = listTaskRuns(taskId);
      const active = allRuns.some((run) => ['queued', 'running'].includes(run.status));
      const completedRuns = allRuns.filter((run) => !['queued', 'running', 'canceled'].includes(run.status)
        && (run.result_json || run.error_message));
      completedRuns.sort((left, right) => {
        const byTime = String(left.completed_at || left.updated_at || left.created_at)
          .localeCompare(String(right.completed_at || right.updated_at || right.created_at));
        return byTime || left.sequence - right.sequence;
      });
      const latest = completedRuns.at(-1);
      if (!active && latest) {
        db.prepare(`
          UPDATE tasks SET source_type = 'claude_history', source_updated_at = ?,
            source_last_synced_at = ?, status = ?, phase = ?, result_json = ?, raw_result = ?,
            error_message = ?, exit_code = ?, completed_at = ?, accepted_at = ?, updated_at = ?
          WHERE id = ?
        `).run(
          sourceUpdated, now, latest.status, runPhase(latest.status), latest.result_json,
          latest.raw_result, latest.error_message, latest.exit_code, latest.completed_at,
          latest.status === 'accepted' ? latest.completed_at : null, now, taskId,
        );
      } else {
        db.prepare(`
          UPDATE tasks SET source_type = 'claude_history', source_updated_at = ?,
            source_last_synced_at = ? WHERE id = ?
        `).run(sourceUpdated, now, taskId);
      }
    } else {
      db.prepare(`
        UPDATE tasks SET source_type = 'claude_history', source_updated_at = ?,
          source_last_synced_at = ? WHERE id = ?
      `).run(sourceUpdated, now, taskId);
    }
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }

  const syncedTask = getTask(taskId);
  if (migratedLegacy || addedRuns.length) touchProject(syncedTask.project_id, syncedTask.updated_at);
  return { task: syncedTask, addedRuns, protected: false, migratedLegacy };
}

export function createTask({ projectId, prompt, parentTaskId = null }) {
  const now = nowIso();
  const task = {
    id: makeId('task'), project_id: projectId, parent_task_id: parentTaskId,
    title: taskTitle(prompt), prompt, status: 'queued', phase: '等待执行',
    created_at: now, updated_at: now,
  };
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      INSERT INTO tasks (id, project_id, parent_task_id, title, prompt, status, phase, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.project_id, task.parent_task_id, task.title, task.prompt, task.status, task.phase, now, now);
    insertTaskRun({ taskId: task.id, sequence: 1, prompt, status: 'queued', createdAt: now, updatedAt: now });
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  const created = getTask(task.id);
  touchProject(projectId, now);
  return created;
}

export function createTaskRun({ taskId, prompt }) {
  const task = getTask(taskId);
  if (!task) return null;
  if (['queued', 'running'].includes(task.status)) throw new Error('当前任务仍在执行，结束后才能继续补充。');
  const now = nowIso();
  const sequence = Number(db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM task_runs WHERE task_id = ?').get(taskId).sequence);
  db.exec('BEGIN IMMEDIATE;');
  try {
    const run = insertTaskRun({ taskId, sequence, prompt, status: 'queued', createdAt: now, updatedAt: now });
    db.prepare(`
      UPDATE tasks SET status = 'queued', phase = '等待继续执行', accepted_at = NULL,
        completed_at = NULL, error_message = NULL, exit_code = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, taskId);
    db.exec('COMMIT;');
    touchProject(task.project_id, now);
    return run;
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

export function listTasks() {
  return db.prepare(`
    SELECT t.*, p.name AS project_name, p.path AS project_path,
      (SELECT COUNT(*) FROM task_runs r WHERE r.task_id = t.id) AS run_count
    FROM tasks t JOIN projects p ON p.id = t.project_id
    ORDER BY t.updated_at DESC, t.created_at DESC
  `).all().map(normalizeTask);
}

export function getTask(id) {
  return normalizeTask(db.prepare(`
    SELECT t.*, p.name AS project_name, p.path AS project_path,
      (SELECT COUNT(*) FROM task_runs r WHERE r.task_id = t.id) AS run_count
    FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.id = ?
  `).get(id));
}

export function getTaskRun(id) {
  return normalizeTaskRun(db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id));
}

function hydrateLatestRunUsage(taskId, runs) {
  const latest = runs.at(-1);
  if (!latest || latest.usage || ['queued', 'running'].includes(latest.status)) return runs;
  const task = db.prepare('SELECT workspace_path FROM tasks WHERE id = ?').get(taskId);
  if (!task?.workspace_path) return runs;
  const resultPath = path.join(path.dirname(task.workspace_path), 'claude-result.json');
  let envelope;
  try {
    envelope = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } catch {
    return runs;
  }
  if (!envelope?.usage && !envelope?.modelUsage && envelope?.total_cost_usd == null) return runs;
  const usage = {
    usage: envelope.usage || null,
    totalCostUsd: envelope.total_cost_usd ?? null,
    numTurns: envelope.num_turns ?? null,
    modelUsage: envelope.modelUsage || null,
  };
  const usageJson = JSON.stringify(usage);
  db.prepare('UPDATE task_runs SET usage_json = ?, updated_at = ? WHERE id = ?').run(usageJson, nowIso(), latest.id);
  latest.usage = usage;
  return runs;
}

export function listTaskRuns(taskId) {
  const runs = db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY sequence ASC').all(taskId).map(normalizeTaskRun);
  return hydrateLatestRunUsage(taskId, runs);
}

export function getPendingTaskRun(taskId) {
  return normalizeTaskRun(db.prepare(`
    SELECT * FROM task_runs WHERE task_id = ? AND status = 'queued'
    ORDER BY sequence ASC LIMIT 1
  `).get(taskId));
}

export function getActiveTaskRun(taskId) {
  return normalizeTaskRun(db.prepare(`
    SELECT * FROM task_runs WHERE task_id = ? AND status IN ('queued', 'running')
    ORDER BY sequence ASC LIMIT 1
  `).get(taskId));
}

export function getNextQueuedTask() {
  return normalizeTask(db.prepare(`
    SELECT t.*, p.name AS project_name, p.path AS project_path,
      (SELECT COUNT(*) FROM task_runs all_runs WHERE all_runs.task_id = t.id) AS run_count
    FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.status = 'queued'
      AND EXISTS (SELECT 1 FROM task_runs r WHERE r.task_id = t.id AND r.status = 'queued')
    ORDER BY (SELECT MIN(r.created_at) FROM task_runs r WHERE r.task_id = t.id AND r.status = 'queued') ASC
    LIMIT 1
  `).get());
}

export function renameTask(id, title) {
  const task = getTask(id);
  if (!task) return null;
  const nextTitle = renameValue(title, '任务名称', 160);
  const updatedAt = nowIso();
  db.prepare('UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?').run(nextTitle, updatedAt, id);
  const renamed = getTask(id);
  touchProject(renamed.project_id, updatedAt);
  return renamed;
}

export function updateTask(id, changes) {
  const allowed = new Set([
    'status', 'phase', 'session_id', 'branch_name', 'workspace_path', 'result_json',
    'raw_result', 'diff_text', 'diff_stat', 'error_message', 'exit_code', 'attempts',
    'started_at', 'completed_at', 'accepted_at', 'source_type', 'source_updated_at',
    'source_last_synced_at', 'updated_at',
  ]);
  const entries = Object.entries(changes).filter(([key]) => allowed.has(key));
  if (!entries.length) return getTask(id);
  const updatedAt = entries.find(([key]) => key === 'updated_at')?.[1] || nowIso();
  if (!entries.some(([key]) => key === 'updated_at')) entries.push(['updated_at', updatedAt]);
  const sql = `UPDATE tasks SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...entries.map(([, value]) => value), id);
  const task = getTask(id);
  if (task) touchProject(task.project_id, updatedAt);
  return task;
}

export function updateTaskRun(id, changes) {
  const allowed = new Set([
    'status', 'result_json', 'raw_result', 'error_message', 'exit_code', 'session_id',
    'usage_json', 'prompt', 'origin', 'source_key', 'created_at', 'started_at', 'completed_at', 'updated_at',
  ]);
  const entries = Object.entries(changes).filter(([key]) => allowed.has(key));
  if (!entries.length) return getTaskRun(id);
  if (!entries.some(([key]) => key === 'updated_at')) entries.push(['updated_at', nowIso()]);
  const sql = `UPDATE task_runs SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...entries.map(([, value]) => value), id);
  return getTaskRun(id);
}

export function recoverInterruptedTasks() {
  const affectedProjects = db.prepare("SELECT DISTINCT project_id FROM tasks WHERE status = 'running'").all();
  const updatedAt = nowIso();
  db.prepare(`
    UPDATE task_runs SET status = 'queued', error_message = NULL, updated_at = ?
    WHERE status = 'running'
  `).run(updatedAt);
  db.prepare(`
    UPDATE tasks SET status = 'queued', phase = '等待重新执行', error_message = NULL, updated_at = ?
    WHERE status = 'running'
  `).run(updatedAt);
  for (const project of affectedProjects) touchProject(project.project_id, updatedAt);
}

export function countRunningTasks() {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'running'").get().count);
}

export function closeDb() {
  db.close();
}
