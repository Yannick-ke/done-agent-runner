import { createTaskWorkspace, collectChanges } from './git.js';
import { executeClaudeTask } from './claude.js';
import { getActiveTaskRun, getNextQueuedTask, getPendingTaskRun, getTask, updateTask, updateTaskRun } from './db.js';
import { claudeFailureInfo, nowIso } from './utils.js';

let active = false;
let activeChild = null;
let wakeTimer = null;

export function startRunner() {
  if (wakeTimer) return;
  wakeTimer = setInterval(() => void tick(), 1500);
  wakeTimer.unref();
  void tick();
}

export function stopRunner() {
  if (wakeTimer) clearInterval(wakeTimer);
  wakeTimer = null;
  activeChild?.kill('SIGTERM');
}

export async function tick() {
  if (active) return;
  const task = getNextQueuedTask();
  if (!task) return;
  active = true;
  try {
    await runTask(task.id);
  } finally {
    active = false;
    setImmediate(() => void tick());
  }
}

async function runTask(id) {
  let task = getTask(id);
  let run = getPendingTaskRun(id);
  if (!task || !run) return;
  const startedAt = nowIso();
  updateTaskRun(run.id, { status: 'running', started_at: startedAt, error_message: null });
  updateTask(id, {
    status: 'running', phase: '正在准备独立工作区', started_at: task.started_at || startedAt,
    attempts: task.attempts + 1, error_message: null,
  });
  try {
    let workspacePath = task.workspace_path;
    let branchName = task.branch_name;
    if (!workspacePath) {
      const workspace = await createTaskWorkspace(task);
      workspacePath = workspace.workspacePath;
      branchName = workspace.branchName;
      updateTask(id, { workspace_path: workspacePath, branch_name: branchName, phase: '正在分析和修改项目' });
    }
    task = getTask(id);
    run = getActiveTaskRun(id);
    if (!run || run.status !== 'running') return;
    const outcome = await executeClaudeTask(task, run, {
      onSpawn: (child) => { activeChild = child; },
      onPhase: (phase) => updateTask(id, { phase }),
    });
    activeChild = null;
    if (getTask(id)?.status === 'canceled') return;

    updateTask(id, { phase: '正在整理结果' });
    const changes = await collectChanges(workspacePath);
    const failure = outcome.isError ? claudeFailureInfo(outcome.rawResult, outcome.stderr) : null;
    const result = outcome.result || {
      outcome: outcome.isError ? 'failed' : 'completed',
      summary: failure?.title || outcome.rawResult || (outcome.stderr ? 'Claude Code 执行失败。' : '任务已执行。'),
      completed_items: [], validation: [], risks: failure ? [failure.message] : [], question: '',
    };
    const status = result.outcome === 'completed' ? 'completed'
      : result.outcome === 'needs_input' ? 'needs_input' : 'failed';
    const completedAt = nowIso();
    const sessionId = outcome.sessionId || task.session_id || null;
    updateTaskRun(run.id, {
      status, session_id: sessionId, result_json: JSON.stringify(result), raw_result: outcome.rawResult,
      usage_json: outcome.usage ? JSON.stringify(outcome.usage) : null,
      error_message: status === 'failed' ? (failure?.message || outcome.stderr || result.summary) : null,
      exit_code: outcome.exitCode, completed_at: completedAt,
    });
    updateTask(id, {
      status,
      phase: status === 'completed' ? '已完成' : status === 'needs_input' ? '需要补充信息' : '未完成',
      session_id: sessionId,
      result_json: JSON.stringify(result), raw_result: outcome.rawResult,
      diff_text: changes.diff, diff_stat: changes.stat || changes.status,
      error_message: status === 'failed' ? (failure?.message || outcome.stderr || result.summary) : null,
      exit_code: outcome.exitCode, completed_at: completedAt,
    });
  } catch (error) {
    activeChild = null;
    if (getTask(id)?.status === 'canceled') return;
    const completedAt = nowIso();
    const activeRun = getActiveTaskRun(id);
    if (activeRun) updateTaskRun(activeRun.id, {
      status: 'failed', error_message: error.stack || error.message,
      completed_at: completedAt, exit_code: Number.isInteger(error.code) ? error.code : -1,
    });
    updateTask(id, {
      status: 'failed', phase: '未完成', error_message: error.stack || error.message,
      completed_at: completedAt, exit_code: Number.isInteger(error.code) ? error.code : -1,
    });
  }
}

export function cancelTask(id) {
  const task = getTask(id);
  if (!task || !['queued', 'running'].includes(task.status)) return task;
  if (task.status === 'running' && activeChild) activeChild.kill('SIGTERM');
  const completedAt = nowIso();
  const run = getActiveTaskRun(id);
  if (run) updateTaskRun(run.id, { status: 'canceled', completed_at: completedAt });
  return updateTask(id, { status: 'canceled', phase: '已取消', completed_at: completedAt });
}
