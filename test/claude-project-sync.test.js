import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverClaudeProjectPaths, syncClaudeHistoryProjects } from '../src/claude-project-sync.js';

function writeSessionIndex(claudeHome, name, originalPath, entries = []) {
  const directory = path.join(claudeHome, 'projects', name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'sessions-index.json'), JSON.stringify({ originalPath, entries }));
}

function makeRepository(root) {
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

test('Claude project discovery combines history and session indexes without duplicates', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-project-discovery-'));
  const claudeHome = path.join(temp, '.claude');
  const first = path.join(temp, 'first');
  const second = path.join(temp, 'second');
  fs.mkdirSync(claudeHome, { recursive: true });

  try {
    fs.writeFileSync(path.join(claudeHome, 'history.jsonl'), [
      JSON.stringify({ project: first, sessionId: 'one' }),
      JSON.stringify({ project: first, sessionId: 'two' }),
      '{invalid json',
    ].join('\n'));
    writeSessionIndex(claudeHome, 'second', second, [{ projectPath: second }]);

    assert.deepEqual(new Set(discoverClaudeProjectPaths({ claudeHome })), new Set([first, second]));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('project sync is additive and idempotent and never rewrites existing Done data', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-project-sync-'));
  const claudeHome = path.join(temp, '.claude');
  const existingRoot = makeRepository(path.join(temp, 'existing'));
  const newRoot = makeRepository(path.join(temp, 'new-project'));
  const nestedPath = path.join(newRoot, 'packages', 'web');
  const worktreeRoot = path.join(temp, 'worktree');
  const tasksRoot = path.join(temp, 'done-tasks');
  const taskWorkspace = makeRepository(path.join(tasksRoot, 'task_1', 'workspace'));
  fs.mkdirSync(nestedPath, { recursive: true });
  fs.mkdirSync(worktreeRoot, { recursive: true });
  fs.writeFileSync(path.join(worktreeRoot, '.git'), 'gitdir: /tmp/main/.git/worktrees/test');

  const existingProject = { id: 'project_existing', name: '保留名称', path: existingRoot };
  const doneState = {
    projects: [existingProject],
    tasks: [{ id: 'task_1', project_id: existingProject.id, prompt: 'Done 中的新沟通' }],
  };
  const originalState = structuredClone(doneState);

  fs.mkdirSync(claudeHome, { recursive: true });
  writeSessionIndex(claudeHome, 'existing', existingRoot);
  writeSessionIndex(claudeHome, 'nested', nestedPath);
  writeSessionIndex(claudeHome, 'worktree', worktreeRoot);
  writeSessionIndex(claudeHome, 'task-workspace', taskWorkspace);

  const canonical = (value) => fs.realpathSync.native(value);
  const roots = new Map([
    [canonical(existingRoot), canonical(existingRoot)],
    [canonical(nestedPath), canonical(newRoot)],
    [canonical(worktreeRoot), canonical(worktreeRoot)],
    [canonical(taskWorkspace), canonical(taskWorkspace)],
  ]);
  const validatePath = async (candidate) => {
    const root = roots.get(canonical(candidate));
    if (!root) throw new Error('invalid');
    return { root, branch: 'main' };
  };
  const created = [];
  const createProject = ({ name, projectPath }) => {
    const project = { id: `project_${created.length + 1}`, name, path: projectPath };
    created.push(project);
    return project;
  };

  try {
    const first = await syncClaudeHistoryProjects({
      existingProjects: doneState.projects,
      createProject,
      claudeHome,
      validatePath,
      excludedRoots: [tasksRoot],
    });

    assert.equal(first.added.length, 1);
    assert.equal(first.added[0].path, canonical(newRoot));
    assert.equal(first.existing, 1);
    assert.equal(first.ignored, 2);
    assert.deepEqual(doneState, originalState, '同步不能修改已有项目、任务或 Done 沟通');

    const second = await syncClaudeHistoryProjects({
      existingProjects: [...doneState.projects, ...first.added],
      createProject,
      claudeHome,
      validatePath,
      excludedRoots: [tasksRoot],
    });

    assert.equal(second.added.length, 0);
    assert.equal(second.existing, 2);
    assert.equal(created.length, 1, '重复同步不能重新创建或覆盖项目');
    assert.deepEqual(doneState, originalState);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
