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

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function isGitInstalled() {
  try {
    const result = await runCommand('git', ['--version'], { allowFailure: true });
    return result.code === 0;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function validateProjectPath(projectPath) {
  const resolved = path.resolve(projectPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('项目目录不存在或不是文件夹。');

  const root = await fs.realpath(resolved);
  const gitAvailable = await isGitInstalled();
  if (!gitAvailable) return { root, branch: null, kind: 'directory', gitAvailable: false };

  const result = await runCommand('git', ['rev-parse', '--show-toplevel'], { cwd: root, allowFailure: true });
  if (result.code !== 0) return { root, branch: null, kind: 'directory', gitAvailable: true };

  const gitRoot = await fs.realpath(result.stdout.trim());
  const branch = (await runCommand('git', ['branch', '--show-current'], { cwd: gitRoot })).stdout.trim();
  if (!branch) throw new Error('项目当前不在普通分支上（可能是 detached HEAD）。');
  return { root: gitRoot, branch, kind: 'git', gitAvailable: true };
}

export async function initializeGitProject(projectPath) {
  const project = await validateProjectPath(projectPath);
  if (project.kind === 'git') return project;
  if (!project.gitAvailable) throw new Error('当前电脑没有检测到 Git，无法自动初始化 Git 项目。');

  try {
    await runCommand('git', ['init', '-b', 'main'], { cwd: project.root });
    await runCommand('git', ['add', '-A'], { cwd: project.root });
    await runCommand('git', [
      '-c', 'user.name=Done Agent Runner',
      '-c', 'user.email=done-agent-runner@localhost',
      'commit', '--no-verify', '--allow-empty', '-m', 'chore: initialize project',
    ], { cwd: project.root });
  } catch (error) {
    throw new Error(`Git 项目初始化失败：${error.message}`);
  }

  return validateProjectPath(project.root);
}

async function createDirectorySnapshot(sourcePath, workspacePath, branchName, gitAvailable) {
  const canonicalSource = await fs.realpath(sourcePath);
  const canonicalParent = await fs.realpath(path.dirname(workspacePath));
  const canonicalWorkspace = path.join(canonicalParent, path.basename(workspacePath));
  if (isInside(canonicalWorkspace, canonicalSource)) {
    throw new Error('任务工作目录不能位于普通项目目录内部，请调整 TASKS_DIR。');
  }

  await fs.rm(workspacePath, { recursive: true, force: true });
  await fs.cp(canonicalSource, workspacePath, {
    recursive: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
  });

  if (!gitAvailable) return;

  try {
    await runCommand('git', ['init', '-b', branchName], { cwd: workspacePath });
    await runCommand('git', ['add', '-A'], { cwd: workspacePath });
    await runCommand('git', [
      '-c', 'user.name=Done Agent Runner',
      '-c', 'user.email=done-agent-runner@localhost',
      'commit', '--allow-empty', '-m', 'chore: create task workspace snapshot',
    ], { cwd: workspacePath });
  } catch (error) {
    await fs.rm(workspacePath, { recursive: true, force: true });
    throw error;
  }
}

export async function createTaskWorkspace(task, options = {}) {
  const tasksDir = options.tasksDir || config.tasksDir;
  await fs.mkdir(tasksDir, { recursive: true });
  const workspacePath = path.join(tasksDir, task.id, 'workspace');
  const taskSuffix = task.id.replace(/^task_/, '').slice(0, 12);
  const project = await validateProjectPath(task.project_path);
  const branchName = project.kind === 'git'
    ? `claude-task/${taskSuffix}`
    : `done-task/${taskSuffix}`;
  await fs.mkdir(path.dirname(workspacePath), { recursive: true });

  const existing = await fs.stat(workspacePath).catch(() => null);
  if (!existing) {
    if (project.kind === 'directory') {
      await createDirectorySnapshot(project.root, workspacePath, branchName, project.gitAvailable);
    } else {
      const branchExists = await runCommand('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
        cwd: project.root,
        allowFailure: true,
      });
      const args = branchExists.code === 0
        ? ['worktree', 'add', workspacePath, branchName]
        : ['worktree', 'add', '-b', branchName, workspacePath, 'HEAD'];
      await runCommand('git', args, { cwd: project.root });
    }
  }
  return { workspacePath, branchName };
}

export async function collectChanges(workspacePath) {
  const gitMetadata = await fs.stat(path.join(workspacePath, '.git')).catch(() => null);
  if (!gitMetadata) return { stat: '', diff: '', status: '' };

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
