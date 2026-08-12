import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; options.onStdout?.(chunk.toString()); });
    child.stderr.on('data', (chunk) => { stderr += chunk; options.onStderr?.(chunk.toString()); });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const result = { code: code ?? -1, signal, stdout, stderr };
      if (options.allowFailure || code === 0) resolve(result);
      else reject(Object.assign(new Error(stderr.trim() || `${command} exited with ${code}`), result));
    });
    options.onSpawn?.(child);
  });
}

export async function validateProjectPath(projectPath) {
  const resolved = path.resolve(projectPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('项目目录不存在或不是文件夹。');
  const result = await runCommand('git', ['rev-parse', '--show-toplevel'], { cwd: resolved, allowFailure: true });
  if (result.code !== 0) throw new Error('目前只支持 Git 项目，请选择包含 .git 的项目目录。');
  const root = result.stdout.trim();
  const branch = (await runCommand('git', ['branch', '--show-current'], { cwd: root })).stdout.trim();
  if (!branch) throw new Error('项目当前不在普通分支上（可能是 detached HEAD）。');
  return { root: path.resolve(root), branch };
}

export async function createTaskWorkspace(task) {
  await fs.mkdir(config.tasksDir, { recursive: true });
  const workspacePath = path.join(config.tasksDir, task.id, 'workspace');
  const branchName = `claude-task/${task.id.replace(/^task_/, '').slice(0, 12)}`;
  await fs.mkdir(path.dirname(workspacePath), { recursive: true });

  const existing = await fs.stat(workspacePath).catch(() => null);
  if (!existing) {
    const branchExists = await runCommand('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
      cwd: task.project_path,
      allowFailure: true,
    });
    const args = branchExists.code === 0
      ? ['worktree', 'add', workspacePath, branchName]
      : ['worktree', 'add', '-b', branchName, workspacePath, 'HEAD'];
    await runCommand('git', args, { cwd: task.project_path });
  }
  return { workspacePath, branchName };
}

export async function collectChanges(workspacePath) {
  const [stat, diff, status] = await Promise.all([
    runCommand('git', ['diff', '--stat', '--no-ext-diff', 'HEAD'], { cwd: workspacePath, allowFailure: true }),
    runCommand('git', ['diff', '--no-ext-diff', '--binary', 'HEAD'], { cwd: workspacePath, allowFailure: true }),
    runCommand('git', ['status', '--short'], { cwd: workspacePath, allowFailure: true }),
  ]);
  return {
    stat: stat.stdout.trim(),
    diff: diff.stdout,
    status: status.stdout.trim(),
  };
}
