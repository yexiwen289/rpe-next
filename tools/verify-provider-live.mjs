import { createOpenAIProvider } from '../src/platform/agent-provider.mjs';

const KEY = process.env.RPE_GLM_API_KEY || '';
if (!KEY) { console.error('请先设置环境变量 RPE_GLM_API_KEY（见 .env.example）'); process.exit(1); }
const provider = createOpenAIProvider({ id: 'glm', name: 'GLM', baseUrl: 'https://xh.v1api.cc/v1', models: ['deepseek-v4.1-flash-1017'], defaultModel: 'deepseek-v4.1-flash-1017', capabilities: { tools: true, streaming: true, images: true, search: false, contextWindow: 131072 } });

const SYSTEM = '你是 VibePhi 的谱面助手。' + '请用简洁的中文回答，并优先使用工具读写谱面。'.repeat(300);
const TOOLS = [{ type: 'function', function: { name: 'chart_read', description: '读取谱面内容'.repeat(10), parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];

async function run(label, config, messages, { tools = TOOLS } = {}) {
  const started = Date.now();
  let text = '', reasoning = '', toolCalls = null, usage = null;
  try {
    const result = await provider.complete({
      config, system: SYSTEM, messages, tools, signal: new AbortController().signal,
      onText: delta => { text += delta; }, onReasoning: delta => { reasoning += delta; },
    });
    usage = result.usage; toolCalls = result.tool_calls ?? null;
    console.log(`${label}\n  用时 ${((Date.now() - started) / 1000).toFixed(1)}s | 输出${text.length}字 | 思考${reasoning.length}字 | 工具${toolCalls ? toolCalls.map(c => c.function.name).join(',') : '无'} | usage: prompt=${usage?.prompt_tokens} completion=${usage?.completion_tokens} reasoning=${usage?.completion_tokens_details?.reasoning_tokens ?? '-'} cached=${usage?.prompt_tokens_details?.cached_tokens ?? '-'}`);
    return { text, reasoning, toolCalls, usage };
  } catch (error) {
    console.log(`${label}\n  失败：${error.message} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    return { error };
  }
}

const base = { key: KEY, model: 'deepseek-v4.1-flash-1017', maxTokens: 16384, timeoutMs: 300000 };

console.log('=== 1) 默认（thinking 未设置 → 关闭）不应产生思考 ===');
await run('[思考默认关]', { ...base }, [{ role: 'user', content: '你好' }], { tools: [] });

console.log('\n=== 2) thinking:false 显式关闭 + 真实写谱请求（含 8K 提示词与工具）===');
await run('[thinking:false]', { ...base, thinking: false }, [{ role: 'user', content: '继续 请直接开始改谱面' }]);

console.log('\n=== 3) thinking:true（用户手动开启）应产生思考但仍能完成 ===');
await run('[thinking:true]', { ...base, thinking: true }, [{ role: 'user', content: '说一句话' }], { tools: [] });

console.log('\n=== 4) 连续两次同前缀（验证前缀缓存命中）===');
await run('[第1次]', { ...base, thinking: false }, [{ role: 'user', content: '读谱面' }]);
await run('[第2次]', { ...base, thinking: false }, [{ role: 'user', content: '读谱面' }]);
