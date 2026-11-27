import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('AgentDialogues 构造器初始化并行上限，避免队列永远停在等待执行', async () => {
  const source = await readFile(new URL('../src/ui/agent-dialogues.mjs', import.meta.url), 'utf8');
  const constructor = source.slice(source.indexOf('constructor(panel)'), source.indexOf('async attach('));
  assert.match(constructor, /this\.parallelLimit\s*=\s*[1-9]\d*/, '构造器必须给 parallelLimit 一个正整数默认值');
  assert.match(source, /active\.size\s*<\s*this\.parallelLimit/, 'drain 必须按并行上限调度');
});
