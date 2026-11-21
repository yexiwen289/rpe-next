import assert from 'node:assert/strict';
import { AgentCommands, agentSchema } from '../src/core/agent-commands.mjs';
import { EditorAgent } from '../src/application/agent.mjs';
import { AgentProviders, createOpenAIProvider } from '../src/platform/agent-provider.mjs';
import { agentSettings, DEFAULT_AGENT_SETTINGS } from '../src/ui/agent-panel.mjs';

const results = [];
const check = (name, fn) => { try { fn(); results.push(['PASS', name]); } catch (error) { results.push(['FAIL', name + ' -> ' + error.message]); } };

// 1) 默认值与迁移
check('默认 maxTokens=16384', () => assert.equal(DEFAULT_AGENT_SETTINGS.maxTokens, 16384));
check('默认 permission=full', () => assert.equal(DEFAULT_AGENT_SETTINGS.permission, 'full'));
check('空存档得到新默认', () => { const s = agentSettings({}); assert.equal(s.maxTokens, 16384); assert.equal(s.permission, 'full'); });
check('旧存档 65536/ask 被迁移', () => {
  const s = agentSettings({ uiVersion: 4, maxTokens: 65536, permission: 'ask' });
  assert.equal(s.maxTokens, 16384); assert.equal(s.permission, 'full');
});
check('新存档保留用户显式选择', () => {
  const s = agentSettings({ uiVersion: 5, maxTokens: 32768, permission: 'ask' });
  assert.equal(s.maxTokens, 32768); assert.equal(s.permission, 'ask');
});

// 3) 能力驱动的工具过滤
async function toolNames(capabilities) {
  const commands = new AgentCommands();
  for (const name of ['web_search', 'web_fetch', 'preview_capture', 'editor_capture', 'chart_read']) {
    commands.register({ name, access: 'read', description: name, parameters: agentSchema(), prepare: () => ({ apply: () => 1 }) });
  }
  const providers = new AgentProviders();
  let offered = [];
  providers.register({ id: 'fixture', capabilities: () => capabilities, complete: async request => { offered = request.tools.map(tool => tool.function.name); return { role: 'assistant', content: 'done' }; } });
  const session = {}, context = { session, summary: { lines: 0 } };
  const agent = new EditorAgent({
    commands, providers, context: () => context,
    config: () => ({ provider: 'fixture', model: 'm', key: 'k', permission: 'full', maxTokens: 1024, maxRounds: 4, prompt: 'p', autoCompact: false }),
    approve: async () => true, ask: async () => ({}), prompt: () => 'p',
  });
  await agent.run('hello');
  return offered;
}

const glmLike = { tools: true, streaming: true, images: true, search: false, contextWindow: 131072 };
const dsLike = { tools: true, images: false, search: true, contextWindow: 1048576 };

await toolNames(glmLike).then(names => {
  check('GLM(无search) 剔除 web_search/web_fetch', () => {
    assert.ok(!names.includes('web_search')); assert.ok(!names.includes('web_fetch'));
  });
  check('GLM(有images) 保留截图类工具', () => {
    assert.ok(names.includes('preview_capture')); assert.ok(names.includes('editor_capture'));
  });
  check('GLM 保留普通工具', () => assert.ok(names.includes('chart_read')));
});
await toolNames(dsLike).then(names => {
  check('DeepSeek(有search) 保留 web_search', () => assert.ok(names.includes('web_search')));
  check('DeepSeek(无images) 剔除截图类工具', () => {
    assert.ok(!names.includes('preview_capture')); assert.ok(!names.includes('editor_capture'));
  });
});

// 2) provider 能力声明
const glm = createOpenAIProvider({ id: 'glm', name: 'GLM', baseUrl: 'https://xh.v1api.cc/v1', models: ['deepseek-v4.1-flash-1017'], capabilities: glmLike });
check('GLM provider 声明 images=true / search=false', () => {
  const caps = glm.capabilities('deepseek-v4.1-flash-1017');
  assert.equal(caps.images, true); assert.equal(caps.search, false); assert.equal(caps.tools, true);
});

// 请求体层面：thinking 开关与长度参数（桩掉 fetch 抓真实 HTTP body）
async function httpBodyOf(config) {
  let captured = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    const sse = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const provider = createOpenAIProvider({ id: 'glm', name: 'GLM', baseUrl: 'https://xh.v1api.cc/v1', models: ['deepseek-v4.1-flash-1017'], capabilities: glmLike });
  const providers = new AgentProviders();
  providers.register(provider);
  const context = { session: {}, summary: {} };
  const agent = new EditorAgent({
    commands: new AgentCommands(), providers, context: () => context,
    config: () => config, approve: async () => true, ask: async () => ({}), prompt: () => 'p',
  });
  try { await agent.run('hi'); } finally { globalThis.fetch = original; }
  return captured;
}

const cfg = { provider: 'glm', model: 'deepseek-v4.1-flash-1017', key: 'k', permission: 'full', maxTokens: 16384, maxRounds: 2, prompt: 'p', autoCompact: false, timeoutMs: 300000 };

const off = await httpBodyOf({ ...cfg, thinking: false });
check('HTTP body 下发 thinking:false', () => assert.equal(off.body.thinking, false));
check('HTTP body 双写 max_tokens / max_completion_tokens', () => {
  assert.equal(off.body.max_tokens, 16384); assert.equal(off.body.max_completion_tokens, 16384);
});
check('HTTP body 命中 GLM base_url', () => assert.equal(off.url, 'https://xh.v1api.cc/v1/chat/completions'));
const on = await httpBodyOf({ ...cfg, thinking: true });
check('HTTP body 下发 thinking:true', () => assert.equal(on.body.thinking, true));

for (const [status, name] of results) console.log(status, '|', name);
console.log(results.every(([s]) => s === 'PASS') ? '\nALL PASS' : `\nFAILED: ${results.filter(([s]) => s === 'PASS').length}/${results.length}`);
