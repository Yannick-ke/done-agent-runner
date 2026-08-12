import {
  createImportedTask,
  getProject,
  listTasksByProject,
  syncImportedTaskTurns,
} from './db.js';
import { syncProjectClaudeHistoryTasks } from './claude-task-sync.js';

const supportedTriggers = new Set(['manual', 'scheduled', 'webhook']);

/**
 * Application-level synchronization entry point.
 *
 * HTTP buttons, a future scheduler and a future webhook handler should call
 * this function instead of coordinating Claude history and database writes
 * independently.
 */
export function syncProjectHistoryTasks({ projectId, trigger = 'manual', options = {} }) {
  if (!supportedTriggers.has(trigger)) throw new Error(`不支持的同步触发方式：${trigger}`);
  const project = getProject(projectId);
  if (!project) throw new Error('同步历史任务时未找到项目。');

  const result = syncProjectClaudeHistoryTasks({
    project,
    existingTasks: listTasksByProject(project.id),
    createImportedTask,
    appendImportedTaskTurns: syncImportedTaskTurns,
    options,
  });
  return { ...result, project, trigger };
}
