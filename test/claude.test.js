import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, claudeArgs, parseClaudeEnvelope } from '../src/claude.js';

const task = {
  id: 'task_1', prompt: '实现登录功能', session_id: 'session_123',
  result: { summary: '登录功能已经实现' }, raw_result: '',
};

test('first task run starts a new Claude session', () => {
  const run = { sequence: 1, prompt: '实现登录功能' };
  const args = claudeArgs(task, run);
  assert.equal(args.includes('--resume'), false);
  assert.ok(args.includes('--json-schema'));
  assert.ok(args.includes('--output-format'));
  const compactIndex = args.indexOf('--autocompact');
  assert.ok(compactIndex > 0);
  assert.equal(args[compactIndex + 1], 'auto');
});

test('Claude JSON envelope usage is preserved for task observability', () => {
  const envelope = parseClaudeEnvelope({
    stdout: JSON.stringify({
      session_id: 'session_123',
      usage: { input_tokens: 1800, cache_read_input_tokens: 64000, output_tokens: 800 },
      modelUsage: { 'claude-sonnet-4-6': { contextWindow: 200000, inputTokens: 1800, outputTokens: 800 } },
      total_cost_usd: 0.08,
      num_turns: 4,
    }),
  });
  assert.equal(envelope.usage.input_tokens, 1800);
  assert.equal(envelope.modelUsage['claude-sonnet-4-6'].contextWindow, 200000);
  assert.equal(envelope.total_cost_usd, 0.08);
  assert.equal(envelope.num_turns, 4);
});

test('follow-up task run resumes the exact task Claude session', () => {
  const run = { sequence: 2, prompt: '把登录按钮改小一点' };
  const args = claudeArgs(task, run);
  const resumeIndex = args.indexOf('--resume');
  assert.ok(resumeIndex > 0);
  assert.equal(args[resumeIndex + 1], task.session_id);
  assert.match(args[args.indexOf('-p') + 1], /第 2 轮沟通/);
  assert.match(args[args.indexOf('-p') + 1], /把登录按钮改小一点/);
});

test('resume fallback prompt restores original task and previous result context', () => {
  const run = { sequence: 3, prompt: '再补充一个失败场景测试' };
  const prompt = buildPrompt(task, run, { fallback: true });
  assert.match(prompt, /原始任务[：：]?\s*\n实现登录功能/);
  assert.match(prompt, /此前结果摘要[：：]?\s*\n登录功能已经实现/);
  assert.match(prompt, /再补充一个失败场景测试/);
});
