const KEY = process.env.RPE_GLM_API_KEY || '';
if (!KEY) { console.error('请先设置环境变量 RPE_GLM_API_KEY（见 .env.example）'); process.exit(1); }
const URL = 'https://xh.v1api.cc/v1/chat/completions';
const SYSTEM = '你是谱面助手。'.repeat(1400); // 约 8.3K 字符，接近项目真实系统提示词
const TOOLS = Array.from({ length: 18 }, (_, i) => ({ type: 'function', function: { name: `tool_${i}`, description: '工具说明'.repeat(20), parameters: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } } } }));

async function call(label, { system = '', tools = [], history = 0, extra = {} } = {}) {
  const messages = [{ role: 'system', content: system }];
  for (let i = 0; i < history; i++) messages.push({ role: 'user', content: '历史轮次内容'.repeat(200) }, { role: 'assistant', content: '历史回复内容'.repeat(200) });
  messages.push({ role: 'user', content: '继续' });
  const body = { model: 'deepseek-v4.1-flash-1017', messages, tools, stream: false, max_tokens: 64, thinking: false, ...extra };
  const started = Date.now();
  try {
    const response = await fetch(URL, { method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const text = await response.text();
    const json = JSON.parse(text);
    const usage = json.usage ?? {};
    console.log(`${label.padEnd(34)} ${String(Date.now() - started).padStart(6)}ms  status=${response.status} prompt_tokens=${usage.prompt_tokens} cached=${usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? '-'} completion=${usage.completion_tokens}`);
    return usage;
  } catch (error) {
    console.log(`${label.padEnd(34)} ERROR ${error.name}: ${error.message} (${Date.now() - started}ms)`);
    return {};
  }
}

console.log('--- 预填充随输入规模的增长（单次）---');
await call('最小输入', {});
await call('+8.3K 系统提示词', { system: SYSTEM });
await call('+8.3K 提示词 +18 工具', { system: SYSTEM, tools: TOOLS });
await call('+8.3K 提示词 +18 工具 +20 轮历史', { system: SYSTEM, tools: TOOLS, history: 20 });

console.log('\n--- 同一前缀连发 3 次，看是否命中前缀缓存 ---');
for (let i = 1; i <= 3; i++) await call(`第 ${i} 次（同前缀）`, { system: SYSTEM, tools: TOOLS });
