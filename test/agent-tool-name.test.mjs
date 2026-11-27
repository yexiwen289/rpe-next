import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('流式工具名不会被中转重复 chunk 拼成 chart_knowledgechart_knowledge', async () => {
  const source = await readFile(new URL('../src/platform/agent-provider.mjs', import.meta.url), 'utf8');
  assert.match(source, /piece\.startsWith\(current\)/, '遇到重复完整工具名必须覆盖而不是累加');
  assert.ok(!/name\s*\+=\s*part\.function\.name/.test(source), '不能再直接 += 拼接工具名');
});
