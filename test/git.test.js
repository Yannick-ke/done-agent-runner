import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectChanges, createTaskWorkspace, initializeGitProject, isGitInstalled, runCommand, validateProjectPath } from '../src/git.js';

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createRepository(root) {
  await fs.mkdir(root, { recursive: true });
  await runCommand('git', ['init', '-b', 'main'], { cwd: root });
  await fs.writeFile(path.join(root, 'README.md'), '# Test\n');
  await runCommand('git', ['add', '-A'], { cwd: root });
  await runCommand('git', [
    '-c', 'user.name=Done Test',
    '-c', 'user.email=done-test@localhost',
    'commit', '-m', 'initial',
  ], { cwd: root });
}

test('validateProjectPath accepts an ordinary local directory', async () => {
  const root = await temporaryDirectory('done-directory-project-');
  try {
    const result = await validateProjectPath(root);
    assert.deepEqual(result, {
      root: await fs.realpath(root),
      branch: null,
      kind: 'directory',
      gitAvailable: true,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateProjectPath keeps Git repository root and branch behavior', async () => {
  const root = await temporaryDirectory('done-git-project-');
  const nested = path.join(root, 'packages', 'web');
  try {
    await createRepository(root);
    await fs.mkdir(nested, { recursive: true });
    const result = await validateProjectPath(nested);
    assert.deepEqual(result, {
      root: await fs.realpath(root),
      branch: 'main',
      kind: 'git',
      gitAvailable: true,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Git installation can be detected before offering initialization', async () => {
  assert.equal(await isGitInstalled(), true);
});

test('initializeGitProject creates a main branch and baseline commit in the selected directory', async () => {
  const root = await temporaryDirectory('done-initialize-git-project-');
  try {
    await fs.writeFile(path.join(root, 'README.md'), '# Existing files\n');
    const result = await initializeGitProject(root);

    assert.deepEqual(result, {
      root: await fs.realpath(root),
      branch: 'main',
      kind: 'git',
      gitAvailable: true,
    });
    assert.equal((await fs.stat(path.join(root, '.git'))).isDirectory(), true);
    assert.equal((await runCommand('git', ['log', '-1', '--format=%s'], { cwd: root })).stdout.trim(), 'chore: initialize project');
    assert.equal((await runCommand('git', ['status', '--short'], { cwd: root })).stdout.trim(), '');
    assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), '# Existing files\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateProjectPath rejects a Git repository on detached HEAD', async () => {
  const root = await temporaryDirectory('done-detached-project-');
  try {
    await createRepository(root);
    await runCommand('git', ['checkout', '--detach', 'HEAD'], { cwd: root });
    await assert.rejects(validateProjectPath(root), /detached HEAD/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ordinary directory tasks use an isolated copied Git snapshot', async () => {
  const temp = await temporaryDirectory('done-directory-workspace-');
  const source = path.join(temp, 'source');
  const tasksDir = path.join(temp, 'tasks');
  try {
    await fs.mkdir(path.join(source, 'nested'), { recursive: true });
    await fs.writeFile(path.join(source, 'nested', 'message.txt'), 'original\n');

    const workspace = await createTaskWorkspace({
      id: 'task_1234567890abcdef',
      project_path: source,
    }, { tasksDir });

    assert.equal(workspace.branchName, 'done-task/1234567890ab');
    assert.equal(await fs.readFile(path.join(workspace.workspacePath, 'nested', 'message.txt'), 'utf8'), 'original\n');
    assert.equal((await fs.stat(path.join(workspace.workspacePath, '.git'))).isDirectory(), true);
    assert.equal((await collectChanges(workspace.workspacePath)).status, '');

    await fs.writeFile(path.join(workspace.workspacePath, 'nested', 'message.txt'), 'changed\n');
    const changes = await collectChanges(workspace.workspacePath);
    assert.match(changes.status, /M nested\/message\.txt/);
    assert.match(changes.diff, /\+changed/);
    assert.equal(await fs.readFile(path.join(source, 'nested', 'message.txt'), 'utf8'), 'original\n');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('Git projects still create an isolated worktree', async () => {
  const temp = await temporaryDirectory('done-git-workspace-');
  const source = path.join(temp, 'source');
  const tasksDir = path.join(temp, 'tasks');
  try {
    await createRepository(source);
    const workspace = await createTaskWorkspace({
      id: 'task_abcdef1234567890',
      project_path: source,
    }, { tasksDir });

    assert.equal(workspace.branchName, 'claude-task/abcdef123456');
    assert.equal(await fs.readFile(path.join(workspace.workspacePath, 'README.md'), 'utf8'), '# Test\n');
    assert.equal((await fs.stat(path.join(workspace.workspacePath, '.git'))).isFile(), true);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('ordinary directory snapshot refuses a TASKS_DIR inside the source', async () => {
  const root = await temporaryDirectory('done-recursive-workspace-');
  try {
    await fs.writeFile(path.join(root, 'file.txt'), 'content');
    await assert.rejects(createTaskWorkspace({
      id: 'task_inside',
      project_path: root,
    }, { tasksDir: path.join(root, '.done-tasks') }), /不能位于普通项目目录内部/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
