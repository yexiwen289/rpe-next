const KEY = process.env.RPE_GLM_API_KEY || '';
if (!KEY) { console.error('请先设置环境变量 RPE_GLM_API_KEY（见 .env.example）'); process.exit(1); }
const URL = 'https://xh.v1api.cc/v1/chat/completions';

async function probe(label, extra) {
  const body = { model: 'deepseek-v4.1-flash-1017', messages: [{ role: 'user', content: '请直接开始改谱面：把第1行加上双押' }], tools: [{ type: 'function', function: { name: 'chart_read', description: '读谱面', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }], stream: true, stream_options: { include_usage: true }, max_tokens: 16384, ...extra };
  const started = Date.now();
  try {
    const response = await fetch(URL, { method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let ttfb = null, reasoning = 0, content = 0, model = '', done = false, finish = '', chunks = 0;
    for (;;) {
      const { done: fin, value } = await reader.read();
      if (fin) break;
      if (ttfb === null) ttfb = Date.now() - started;
      chunks++;
      for (const line of decoder.decode(value, { stream: true }).split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') { done = true; continue; }
        try { const json = JSON.parse(data); model = json.model || model; const choice = json.choices?.[0]; if (choice?.finish_reason) finish = choice.finish_reason; const delta = choice?.delta ?? {}; if (delta.reasoning_content) reasoning += String(delta.reasoning_content).length; if (delta.content) content += String(delta.content).length; } catch {}
      }
    }
    console.log(`${label.padEnd(28)} ttfb=${String(ttfb ?? '-').padStart(6)}ms chunks=${String(chunks).padStart(4)} reasoningChars=${String(reasoning).padStart(6)} contentChars=${String(content).padStart(5)} done=${done} finish=${finish || '-'} model=${model}`);
  } catch (error) {
    console.log(`${label.padEnd(28)} ERROR ${error.name}: ${error.message} (after ${Date.now() - started}ms)`);
  }
}

await probe('(无 thinking 参数)', {});
await probe('thinking:false', { thinking: false });
await probe('enable_thinking:false', { enable_thinking: false });
await probe('chat_template_kwargs', { chat_template_kwargs: { enable_thinking: false } });
await probe('both', { thinking: false, enable_thinking: false });
await probe('reasoning_effort:none', { reasoning_effort: 'none' });
