import { checkAgentSignal } from '../core/agent-commands.mjs';
import { t } from '../i18n.mjs';

export class AgentProviders extends EventTarget {
  constructor() { super(); this.entries = new Map(); }
  register(provider) {
    if (!/^[a-z][a-z0-9-]+$/.test(provider.id) || this.entries.has(provider.id) || typeof provider.complete !== 'function') throw Error(t('agent-provider.s64b4a63'));
    this.entries.set(provider.id, provider); this.dispatchEvent(new Event('change'));
    return () => { if (this.entries.get(provider.id) === provider) { this.entries.delete(provider.id); this.dispatchEvent(new Event('change')); } };
  }
  // Replace-or-register. User-configurable providers change baseUrl/model at
  // runtime, so the same id must be re-registerable.
  upsert(provider) {
    if (!/^[a-z][a-z0-9-]+$/.test(provider.id) || typeof provider.complete !== 'function') throw Error(t('agent-provider.s64b4a63'));
    this.entries.set(provider.id, provider); this.dispatchEvent(new Event('change'));
    return () => { if (this.entries.get(provider.id) === provider) { this.entries.delete(provider.id); this.dispatchEvent(new Event('change')); } };
  }
  get(id) { const provider = this.entries.get(id); if (!provider) throw Error(t('agent-provider.s0c2e384')); return provider; }
}

export async function agentHttp(path, key, body, { signal, onChunk, request, baseUrl = 'https://api.deepseek.com', timeoutMs = 180000 } = {}) {
  checkAgentSignal(signal);
  if (!key?.trim()) throw Error(t('agent-provider.s4c02bba'));
  if (globalThis.rpenAgentNetwork && !request) {
    const id = crypto.randomUUID(), bridge = globalThis.rpenAgentNetwork;
    let chunkError;
    const dispose = bridge.onChunk(id, chunk => { try { onChunk?.(chunk); } catch (error) { chunkError = error; bridge.cancel(id); } });
    const abort = () => bridge.cancel(id); signal?.addEventListener('abort', abort, { once: true });
    try { const response = await bridge.request(id, path, key, body, baseUrl, timeoutMs); if (chunkError) throw chunkError; if (!response.ok) throw Object.assign(Error(response.message), { status: response.status, responseBody: response.responseBody, timeout: response.timeout }); return response.result; }
    finally { signal?.removeEventListener('abort', abort); dispose(); }
  }
  request ??= globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  let timer; const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), timeoutMs); }; arm();
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
  let response;
  try { response = await request(baseUrl + path, { method: path === '/models' ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, ...(path === '/models' ? {} : { body: JSON.stringify(body) }), signal: controller.signal }); }
  catch (error) { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (signal?.aborted) throw error; throw Object.assign(Error(t('agent-provider.sad3a12f')), { timeout: controller.signal.aborted }); }
  if (!response.ok) {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    const messages = { 400: t('agent-provider.s6edbadf'), 401: t('agent-provider.sf3a6b8a'), 402: t('agent-provider.sc1ab622'), 403: t('agent-provider.sc96b373'), 429: t('agent-provider.s14c9516'), 503: t('agent-provider.s4cf3d3f') };
    let responseBody = ''; try { responseBody = (await response.text()).replaceAll(key, '[已隐藏]'); } catch {}
    controller.abort();
    throw Object.assign(Error(t('agent-provider.s9374470', { p0: response.status, p1: messages[response.status] ?? t('agent-provider.s2b93754') })), { status: response.status, responseBody });
  }
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let size = 0, contents = '';
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; arm(); size += value.byteLength; if (size > 16 * 1024 * 1024) throw Error(t('agent-provider.s4bd8619')); const chunk = decoder.decode(value, { stream: true }); if (onChunk) onChunk(chunk); else contents += chunk; }
    const rest = decoder.decode(); if (onChunk) onChunk(rest); else return JSON.parse(contents + rest);
  } finally { reader.releaseLock(); clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
}

export function createDeepSeekProvider(request) {
  const call = (path, config, body, options) => agentHttp(path, config.key, body, { ...options, request: request ?? (globalThis.rpenAgentNetwork ? undefined : globalThis.fetch.bind(globalThis)) });
  const metadata = new Map();
  return {
    id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    capabilities(model) { return { tools: true, images: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model), search: true, streaming: true, contextWindow: 1048576 }; },
    async listModels(config, { signal } = {}) {
      checkAgentSignal(signal);
      const key = 'model-list:' + config.key, cached = metadata.get(key);
      if (cached && Date.now() - cached.at < 3600000) return cached.value;
      try {
        const response = await call('/models', config, {}, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
        const found = Array.isArray(response?.data) ? response.data.map(entry => entry?.id).filter(id => typeof id === 'string' && id.trim()) : [];
        const value = [...new Set([...found, ...this.models])];
        metadata.set(key, { at: Date.now(), value });
        return value;
      } catch { return [...this.models]; }
    },
    async modelInfo(config, { signal } = {}) {
      checkAgentSignal(signal);
      const identity = config.key + '\n' + config.model, cached = metadata.get(identity);
      if (cached && Date.now() - cached.at < 3600000) return cached.value;
      let response;
      try { response = await call('/models', config, {}, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) }); }
      catch (error) { checkAgentSignal(signal); const value = { contextWindow: 1048576, source: 'fallback' }; metadata.set(identity, { at: Date.now() - 3540000, value }); return value; }
      const model = response.data?.find(entry => entry.id === config.model);
      const contextWindow = Number(model?.context_window ?? model?.context_length ?? model?.max_model_len);
      const value = Number.isSafeInteger(contextWindow) && contextWindow >= 8192 ? { contextWindow, source: 'provider' } : { contextWindow: 1048576, source: 'fallback' };
      metadata.set(identity, { at: Date.now(), value }); if (metadata.size > 32) metadata.delete(metadata.keys().next().value);
      return value;
    },
    async complete({ config, system, messages, tools, signal, onText, onReasoning, onTrace }) {
      const body = { model: config.model, messages: [{ role: 'system', content: system }, ...messages.map(({ usage, model, ...message }) => {
        if (!config.thinking) delete message.reasoning_content;
        else if (message.role === 'assistant' && message.tool_calls?.length) message.reasoning_content ??= '';
        return message;
      })], tools, stream: true, stream_options: { include_usage: true }, max_tokens: config.maxTokens ?? 65536 };
      if (config.model.startsWith('deepseek-v4') || config.model === 'deepseek-flash') body.thinking = { type: config.thinking ? 'enabled' : 'disabled' };
      else if (config.model === 'deepseek-chat' && config.thinking) body.thinking = { type: 'enabled' };
      onTrace?.({ request: { url: 'https://api.deepseek.com/chat/completions', method: 'POST', headers: { Authorization: '[已隐藏]', 'Content-Type': 'application/json' }, body } });
      let pending = '', content = '', reasoning = '', finish = '', receivedDone = false, usage = null, model = config.model; const calls = new Map();
      let raw = '';
      try { await call('/chat/completions', config, body, { signal, onChunk(chunk) {
        raw += chunk;
        pending += chunk;
        const lines = pending.split(/\r?\n/); pending = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim(); if (!data) continue; if (data === '[DONE]') { receivedDone = true; continue; }
          const response = JSON.parse(data); if (response.error) throw Error(t('agent-provider.sd4715d7'));
          if (response.usage) usage = response.usage;
          if (response.model) model = response.model;
          const choice = response.choices?.[0]; if (!choice) continue;
          finish = choice.finish_reason ?? finish; const delta = choice.delta ?? {};
          if (delta.content) { content += delta.content; onText?.(delta.content); }
          if (delta.reasoning_content) { reasoning += delta.reasoning_content; onReasoning?.(delta.reasoning_content); }
          for (const part of delta.tool_calls ?? []) {
            const index = part.index ?? 0; let entry = calls.get(index);
            if (!entry) { entry = { id: '', type: 'function', function: { name: '', arguments: '' } }; calls.set(index, entry); }
            if (part.id) entry.id = part.id;
            if (part.function?.name) {
              const piece = part.function.name, current = entry.function.name;
              // 标准 SSE 分片：chart_ + knowledge；某些中转会在多个 chunk 重复发完整名，
              // 若直接 += 会拼成 chart_knowledgechart_knowledge。已累积内容被新分片包含时跳过。
              if (!current || piece.startsWith(current)) entry.function.name = piece;
              else if (!current.startsWith(piece)) entry.function.name = current + piece;
            }
            if (part.function?.arguments) entry.function.arguments += part.function.arguments;
          }
        }
      } }); } catch (error) { onTrace?.({ response: { status: error.status, body: raw || error.responseBody || '', interrupted: Boolean(signal?.aborted) } }); throw error; }
      onTrace?.({ response: { status: 200, body: raw, format: 'text/event-stream' } });
      if (!receivedDone || !finish) throw Error(t('agent-provider.sda51075'));
      if (finish === 'length') throw Error(t('agent-provider.sa887565'));
      const toolCalls = [...calls.values()];
      if (toolCalls.some(entry => !entry.id || !entry.function.name)) throw Error(t('agent-provider.sfc19d6a'));
      return { role: 'assistant', content: content || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}), usage, model };
    },
    async search(config, query, signal) { return call('/v1/tools/search', config, { query, count: 5, need_content: false }, { signal }); },
    async fetch(config, url, signal) { return call('/v1/tools/fetch', config, { url }, { signal }); },
  };
}

export function createOpenAIProvider({ id, name, baseUrl, models = [], defaultModel, capabilities = {}, contextWindow = 1048576, omitThinking = false } = {}) {
  if (!/^[a-z][a-z0-9-]+$/.test(id)) throw Error(t('agent-provider.s64b4a63'));
  const call = (path, config, body, options) => agentHttp(path, config.key, body, { ...options, baseUrl, request: options?.request ?? (globalThis.rpenAgentNetwork ? undefined : globalThis.fetch.bind(globalThis)) });
  const metadata = new Map();
  return {
    id, name, defaultModel: defaultModel ?? models[0], models,
    capabilities(model) { return { tools: true, streaming: true, contextWindow, ...capabilities }; },
    async listModels(config, { signal } = {}) {
      checkAgentSignal(signal);
      const key = 'model-list:' + config.key, cached = metadata.get(key);
      if (cached && Date.now() - cached.at < 3600000) return cached.value;
      try {
        const response = await call('/models', config, {}, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
        const found = Array.isArray(response?.data) ? response.data.map(entry => entry?.id).filter(id => typeof id === 'string' && id.trim()) : [];
        const value = [...new Set([...found, ...models])];
        metadata.set(key, { at: Date.now(), value });
        return value;
      } catch { return [...models]; }
    },
    async modelInfo(config, { signal } = {}) {
      checkAgentSignal(signal);
      const identity = config.key + '\n' + config.model, cached = metadata.get(identity);
      if (cached && Date.now() - cached.at < 3600000) return cached.value;
      let value = { contextWindow, source: 'fallback' };
      try {
        const response = await call('/models', config, {}, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
        const model = response.data?.find(entry => entry.id === config.model);
        const detected = Number(model?.context_window ?? model?.context_length ?? model?.max_model_len);
        if (Number.isSafeInteger(detected) && detected >= 8192) value = { contextWindow: detected, source: 'provider' };
        metadata.set(identity, { at: Date.now(), value }); if (metadata.size > 32) metadata.delete(metadata.keys().next().value);
      } catch { metadata.set(identity, { at: Date.now() - 3540000, value }); }
      return value;
    },
    async complete({ config, system, messages, tools, signal, onText, onReasoning }) {
      const maxTokens = config.maxTokens ?? 16384;
      // `thinking:false` is the only switch some OpenAI-compatible relays honour
      // for GLM-family models; without it the model keeps burning reasoning
      // tokens that `max_tokens` does not cap.
      const body = { model: config.model, messages: [{ role: 'system', content: system }, ...messages.map(({ usage, model, ...message }) => message)], tools, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens, max_completion_tokens: maxTokens };
      // `thinking` is a GLM-relay extension. Most OpenAI-compatible endpoints
      // (e.g. SenseNova) reject the unknown field with HTTP 400, so custom
      // providers omit it by default.
      if (!omitThinking) body.thinking = config.thinking !== false;
      let pending = '', content = '', reasoning = '', finish = '', receivedDone = false, usage = null, model = config.model; const calls = new Map(); let raw = '';
      const attempt = async () => {
        pending = ''; content = ''; reasoning = ''; finish = ''; receivedDone = false; usage = null; model = config.model; calls.clear(); raw = '';
        await call('/chat/completions', config, body, { signal, timeoutMs: config.timeoutMs, onChunk(chunk) {
          raw += chunk; pending += chunk; const lines = pending.split(/\r?\n/); pending = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data:')) continue; const data = line.slice(5).trim(); if (!data) continue; if (data === '[DONE]') { receivedDone = true; continue; }
            let response; try { response = JSON.parse(data); } catch { continue; }
            if (response.error) throw Error(t('agent-provider.sd4715d7')); if (response.usage) usage = response.usage; if (response.model) model = response.model;
            const choice = response.choices?.[0]; if (!choice) continue; finish = choice.finish_reason ?? finish; const delta = choice.delta ?? {};
            if (delta.content) { content += delta.content; onText?.(delta.content); }
            if (delta.reasoning_content) { reasoning += delta.reasoning_content; onReasoning?.(delta.reasoning_content); }
            for (const part of delta.tool_calls ?? []) {
              const index = part.index ?? 0; let entry = calls.get(index);
              if (!entry) { entry = { id: '', type: 'function', function: { name: '', arguments: '' } }; calls.set(index, entry); }
              if (part.id) entry.id = part.id;
              if (part.function?.name) {
              const piece = part.function.name, current = entry.function.name;
              // 标准 SSE 分片：chart_ + knowledge；某些中转会在多个 chunk 重复发完整名，
              // 若直接 += 会拼成 chart_knowledgechart_knowledge。已累积内容被新分片包含时跳过。
              if (!current || piece.startsWith(current)) entry.function.name = piece;
              else if (!current.startsWith(piece)) entry.function.name = current + piece;
            }
              if (part.function?.arguments) entry.function.arguments += part.function.arguments;
            }
          }
        } }) };
      try { await attempt(); }
      catch (error) {
        // A stalled upstream is common on this relay: retry once when nothing
        // was received, so a single slow response does not fail the whole turn.
        if (signal?.aborted || content || reasoning || calls.size) throw error;
        if (error?.timeout) throw error;
        const status = Number(error?.status ?? 0);
        if (status && status !== 408 && status !== 429 && status < 500) throw error;
        await new Promise(resolve => setTimeout(resolve, 1200));
        await attempt();
      }
      const toolCalls = [...calls.values()];
      // A truncated stream is usable when there is no tool call to parse; only
      // bail out when the tool arguments were cut mid-way.
      if (!content && !toolCalls.length && !reasoning) throw Error(t('agent-provider.sda51075'));
      if (finish === 'length' && toolCalls.length) throw Error(t('agent-provider.sa887565'));
      if (toolCalls.some(entry => !entry.id || !entry.function.name)) throw Error(t('agent-provider.sfc19d6a'));
      return { role: 'assistant', content: content || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}), usage, model };
    },
  };
}
