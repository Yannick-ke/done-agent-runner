import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { runCommand } from './git.js';

const resultSchema = JSON.stringify({
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['completed', 'needs_input', 'failed'] },
    summary: { type: 'string' },
    completed_items: { type: 'array', items: { type: 'string' } },
    validation: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          passed: { type: 'boolean' },
          details: { type: 'string' },
        },
        required: ['name', 'passed', 'details'],
        additionalProperties: false,
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    question: { type: 'string' },
  },
  required: ['outcome', 'summary', 'completed_items', 'validation', 'risks', 'question'],
  additionalProperties: false,
});

export function buildPrompt(task, run, { fallback = false } = {}) {
  const continuation = run.sequence > 1
    ? `\n这是同一任务的第 ${run.sequence} 轮沟通。请基于当前工作区和既有任务上下文继续推进。`
    : '';
  const fallbackContext = fallback
    ? `\n此前 Claude 会话无法恢复，因此下面补充了任务上下文。\n原始任务：\n${task.prompt}\n此前结果摘要：\n${task.result?.summary || task.raw_result || '暂无可用摘要'}\n`
    : '';
  return `你正在一个独立 Git 工作区中执行软件任务。${continuation}${fallbackContext}

用户这次的要求：
${run.prompt}

执行要求：
1. 自主理解项目，直接完成任务，不要等待交互式确认。
2. 可以读取和修改当前工作区、运行必要的测试或检查。
3. 不要执行 git push、部署生产环境、访问用户私密目录或破坏当前工作区之外的内容。
4. 不要为了形式而提交 Git commit；平台会直接收集工作区差异。
5. 尽量验证结果。若关键需求确实无法推断，保留当前有价值的变更并把 outcome 设为 needs_input，同时在 question 中只提出一个明确问题。
6. 完成后严格按照要求返回结构化结果，面向普通用户描述成果，不要输出思考过程。
`;
}

export function claudeArgs(task, run, { resume = Boolean(task.session_id && run.sequence > 1), fallback = false } = {}) {
  const args = [
    '-p', buildPrompt(task, run, { fallback }),
    '--output-format', 'json',
    '--json-schema', resultSchema,
    '--permission-mode', 'acceptEdits',
    '--max-turns', String(config.maxTurns),
    '--tools', 'Read,Edit,Write,Glob,Grep,Bash',
    '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash',
    '--disallowedTools', 'WebFetch,WebSearch',
  ];
  if (config.claudeAutocompact && config.claudeAutocompact !== 'off') {
    args.push('--autocompact', config.claudeAutocompact);
  }
  if (resume) args.push('--resume', task.session_id);
  if (config.claudeModel) args.push('--model', config.claudeModel);
  if (config.maxBudgetUsd) args.push('--max-budget-usd', config.maxBudgetUsd);
  return args;
}

export function parseClaudeEnvelope(execution) {
  let envelope = null;
  try { envelope = JSON.parse(execution.stdout || ''); } catch { /* handled by the caller */ }
  return envelope;
}

function isResumeFailure(execution) {
  const text = `${execution.stdout || ''}\n${execution.stderr || ''}`;
  return /(?:session|conversation).{0,100}(?:not found|does not exist|invalid|unavailable)|(?:unable|cannot|failed).{0,100}(?:resume|session)/i.test(text);
}

async function runClaude(task, run, { onSpawn, onPhase, resume, fallback = false }) {
  const args = claudeArgs(task, run, { resume, fallback });
  onPhase?.(resume ? 'Claude 正在恢复之前的沟通' : 'Claude 正在处理任务');
  return runCommand(config.claudeCommand, args, {
    cwd: task.workspace_path,
    allowFailure: true,
    onSpawn,
  });
}

export async function executeClaudeTask(task, run, { onSpawn, onPhase } = {}) {
  const taskDir = path.dirname(task.workspace_path);
  await fs.mkdir(taskDir, { recursive: true });
  const stdoutPath = path.join(taskDir, 'claude-result.json');
  const stderrPath = path.join(taskDir, 'claude-stderr.log');
  const shouldResume = Boolean(task.session_id && run.sequence > 1);
  let execution = await runClaude(task, run, { onSpawn, onPhase, resume: shouldResume });
  let resumed = shouldResume;
  let fellBackFromResume = false;

  if (shouldResume && execution.code !== 0 && isResumeFailure(execution)) {
    fellBackFromResume = true;
    resumed = false;
    execution = await runClaude(task, run, { onSpawn, onPhase, resume: false, fallback: true });
  }

  await Promise.all([
    fs.writeFile(stdoutPath, execution.stdout),
    fs.writeFile(stderrPath, execution.stderr),
  ]);

  const envelope = parseClaudeEnvelope(execution);
  const structured = envelope?.structured_output || envelope?.structuredOutput || null;
  return {
    exitCode: execution.code,
    sessionId: envelope?.session_id || null,
    result: structured,
    rawResult: envelope?.result || execution.stdout.trim(),
    stderr: execution.stderr.trim(),
    subtype: envelope?.subtype || null,
    isError: Boolean(envelope?.is_error) || execution.code !== 0,
    resumed,
    fellBackFromResume,
    usage: envelope ? {
      usage: envelope.usage || null,
      totalCostUsd: envelope.total_cost_usd ?? null,
      numTurns: envelope.num_turns ?? null,
      modelUsage: envelope.modelUsage || null,
    } : null,
  };
}
