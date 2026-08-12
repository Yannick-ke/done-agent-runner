import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = Object.freeze({
  rootDir,
  publicDir: path.join(rootDir, 'public'),
  dataDir: process.env.DATA_DIR || path.join(rootDir, 'data'),
  databasePath: process.env.DATABASE_PATH || path.join(rootDir, 'data', 'tasks.db'),
  tasksDir: process.env.TASKS_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'Done', 'tasks'),
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 4173),
  claudeCommand: process.env.CLAUDE_COMMAND || 'claude',
  claudeModel: process.env.CLAUDE_MODEL || '',
  maxTurns: Number(process.env.CLAUDE_MAX_TURNS || 30),
  maxBudgetUsd: process.env.CLAUDE_MAX_BUDGET_USD || '',
  // Let Claude Code decide when the context window needs compacting. Set
  // CLAUDE_AUTOCOMPACT=off to disable it, or pass a token threshold such as
  // CLAUDE_AUTOCOMPACT=100000 for an explicit threshold.
  claudeAutocompact: process.env.CLAUDE_AUTOCOMPACT || 'auto',
});
