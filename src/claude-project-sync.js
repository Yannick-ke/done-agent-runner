import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { validateProjectPath } from './git.js';

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function readJsonLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function normalized(value) {
  if (!value || typeof value !== 'string') return '';
  const resolved = path.resolve(value);
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}

function isInside(candidate, parent) {
  if (!candidate || !parent) return false;
  const relative = path.relative(normalized(parent), normalized(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function discoverClaudeProjectPaths(options = {}) {
  const claudeHome = options.claudeHome || path.join(os.homedir(), '.claude');
  const projectsDir = path.join(claudeHome, 'projects');
  let directories = [];
  try {
    directories = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((item) => item.isDirectory());
  } catch {
    return [];
  }

  const candidates = new Set(readJsonLines(path.join(claudeHome, 'history.jsonl'))
    .map((entry) => normalized(entry.project))
    .filter(Boolean));
  for (const directory of directories) {
    const index = readJson(path.join(projectsDir, directory.name, 'sessions-index.json'));
    if (!index) continue;
    const values = [index.originalPath, ...(Array.isArray(index.entries) ? index.entries.map((entry) => entry.projectPath) : [])];
    for (const value of values) {
      const projectPath = normalized(value);
      if (projectPath && path.isAbsolute(value)) candidates.add(projectPath);
    }
  }
  return [...candidates];
}

export async function syncClaudeHistoryProjects({
  existingProjects = [],
  createProject,
  claudeHome,
  validatePath = validateProjectPath,
  excludedRoots = [config.tasksDir, path.join(config.rootDir, 'data', 'tasks')],
} = {}) {
  if (typeof createProject !== 'function') throw new Error('同步历史项目缺少项目创建方法。');

  const candidates = discoverClaudeProjectPaths({ claudeHome });
  const knownPaths = new Set(existingProjects.map((project) => normalized(project.path)).filter(Boolean));
  const handledRoots = new Set();
  const result = { discovered: candidates.length, added: [], existing: 0, ignored: 0 };

  for (const candidate of candidates) {
    if (excludedRoots.some((root) => isInside(candidate, root))) {
      result.ignored += 1;
      continue;
    }

    try {
      const validated = await validatePath(candidate);
      const root = normalized(validated.root);
      const gitDirectory = fs.statSync(path.join(root, '.git'), { throwIfNoEntry: false });

      // 子目录归并到所属仓库；.git 为文件的 Git Worktree 不作为独立项目同步。
      if (!gitDirectory?.isDirectory()) {
        result.ignored += 1;
        continue;
      }
      if (handledRoots.has(root)) continue;
      handledRoots.add(root);

      if (knownPaths.has(root)) {
        result.existing += 1;
        continue;
      }

      try {
        const project = createProject({ name: path.basename(root), projectPath: root });
        knownPaths.add(root);
        result.added.push(project);
      } catch (error) {
        if (String(error?.message || '').includes('UNIQUE constraint')) {
          knownPaths.add(root);
          result.existing += 1;
          continue;
        }
        throw error;
      }
    } catch {
      result.ignored += 1;
    }
  }

  return result;
}
