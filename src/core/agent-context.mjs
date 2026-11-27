import { t } from '../i18n.mjs';
export const AGENT_MEMORY_PREFIX = t('agent-context.s39718a0');
export const AGENT_COMPACTION_PROMPT = t('agent-context.sc61702d');

export function estimateAgentTokens(value) {
  let images = 0;
  const source = typeof value === 'string' ? value : JSON.stringify(value, (key, entry) => key === 'image_url' ? (images++, '[图像]') : entry);
  let total = images * 2048;
  for (let index = 0; index < source.length; index++) total += source.charCodeAt(index) > 255 ? 1 : 0.3;
  return Math.ceil(total);
}

export function agentContextPolicy(config = {}, capabilities = {}) {
  const provided = Number(capabilities.contextWindow);
  // Modern chat models are overwhelmingly 1M-context. A provider-declared
  // value still wins, but the fallback must not silently cap a 1M model at
  // 128K (which used to trigger compaction around ~85-100K tokens).
  const contextWindow = Number.isSafeInteger(provided) && provided >= 8192 ? provided : 1048576;
  const requested = Number(config.contextBudget);
  const threshold = Number.isSafeInteger(requested) && requested >= 8192 ? requested : Math.floor(contextWindow * 0.65);
  return { contextWindow, threshold: Math.max(1024, Math.min(threshold, contextWindow - (config.maxTokens ?? 65536) - 4096)), automatic: config.autoCompact !== false };
}

export function agentContextUsage(tokens, policy, estimated = true) {
  tokens = Math.max(0, Math.round(Number(tokens) || 0));
  return { ...policy, tokens, ratio: tokens / policy.contextWindow, estimated };
}

export function agentContextSignature(config, context) {
  let fingerprint = 2166136261;
  for (const character of config.prompt ?? '') fingerprint = Math.imul(fingerprint ^ character.charCodeAt(0), 16777619);
  return JSON.stringify([config.provider, config.model, config.permission, fingerprint >>> 0, context]);
}

// ---------------------------------------------------------------------------
// Tool-result compaction
//
// A single chart_read / editor_context / chart_insights / audio_analyze call can
// return tens of thousands of characters. A handful of those in one turn is
// enough to blow the context window, and the model rarely needs every raw bin
// or note. We keep the *shape* (status, counts, revision, error, summary, first
// N items, long strings head+tail) and add a hint telling the agent how to
// re-query with offset/limit/fields/detail when it really needs more.
//
// This is deliberately structural rather than a blind slice: a truncated JSON
// string loses the closing braces and the useful metadata at the top.
// ---------------------------------------------------------------------------

export const AGENT_TOOL_RESULT_CHARS = 6000;

function safeStringify(value) {
  try { return JSON.stringify(value); }
  catch { return String(value); }
}

export function compressToolResult(value, {
  maxChars = AGENT_TOOL_RESULT_CHARS,
  maxArray = 12,
  maxString = 640,
  maxDepth = 6,
} = {}) {
  const original = safeStringify(value);
  const limit = Math.max(400, Math.floor(Number(maxChars) || AGENT_TOOL_RESULT_CHARS));
  if (original.length <= limit) return { text: original, compressed: false, originalChars: original.length, keptChars: original.length };

  const build = limits => {
    const seen = new WeakSet();
    const walk = (node, depth) => {
      if (node === null || typeof node !== 'object') {
        if (typeof node === 'string' && node.length > limits.maxString) {
          const head = Math.floor(limits.maxString * 0.72), tail = Math.max(0, Math.floor(limits.maxString * 0.2));
          return node.slice(0, head) + '\n…[' + (node.length - head - tail) + t('agent-context.toolCharsOmitted') + ']…\n' + (tail ? node.slice(-tail) : '');
        }
        return node;
      }
      if (seen.has(node)) return '[circular]';
      if (depth >= limits.maxDepth) return Array.isArray(node) ? `[${node.length} items]` : '{…}';
      seen.add(node);
      if (Array.isArray(node)) {
        const head = node.slice(0, limits.maxArray).map(item => walk(item, depth + 1));
        if (node.length > limits.maxArray) head.push({ _omitted: node.length - limits.maxArray, _hint: t('agent-context.toolArrayHint') });
        return head;
      }
      const out = {};
      for (const [key, entry] of Object.entries(node)) out[key] = walk(entry, depth + 1);
      return out;
    };
    const walked = walk(value, 0);
    if (walked && typeof walked === 'object' && !Array.isArray(walked)) {
      walked._compressed = true;
      walked._hint = t('agent-context.toolResultHint');
    }
    return safeStringify(walked);
  };

  let text = build({ maxArray, maxString, maxDepth });
  if (text.length > limit) text = build({ maxArray: Math.max(2, maxArray >> 1), maxString: Math.max(160, maxString >> 1), maxDepth: Math.max(2, maxDepth - 1) });
  if (text.length > limit) text = build({ maxArray: 2, maxString: 160, maxDepth: 2 });
  if (text.length > limit) {
    // Last resort: keep only the status metadata and a JSON-valid short preview.
    const shell = {};
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of ['ok', 'error', 'cancelled', 'denied', 'message', 'revision', 'summary', 'total', 'count']) if (Object.hasOwn(value, key)) shell[key] = value[key];
    }
    shell._compressed = true;
    shell._hint = t('agent-context.toolResultHint');
    shell._originalChars = original.length;
    shell._preview = '';
    const base = safeStringify(shell);
    let preview = text.slice(0, Math.max(0, limit - base.length));
    for (;;) {
      shell._preview = preview;
      const candidate = safeStringify(shell);
      if (candidate.length <= limit || !preview.length) { text = candidate; break; }
      preview = preview.slice(0, Math.floor(preview.length * 0.8));
    }
  }
  return { text, compressed: true, originalChars: original.length, keptChars: text.length };
}

export function prepareAgentHistory(messages, { preserveToolReasoning = true, maxChars = AGENT_TOOL_RESULT_CHARS } = {}) {
  return structuredClone(messages).map(message => {
    if (!preserveToolReasoning || !message.tool_calls?.length) delete message.reasoning_content;
    if (message.role === 'tool' && typeof message.content === 'string' && message.content.length > maxChars) {
      let parsed;
      try { parsed = JSON.parse(message.content); } catch { parsed = undefined; }
      message.content = parsed === undefined
        ? message.content.slice(0, Math.floor(maxChars * 0.85)) + t('agent-context.s6268ab4')
        : compressToolResult(parsed, { maxChars }).text;
    }
    return message;
  });
}

export function agentContextCut(messages, keep = 10) {
  const pending = new Set(); let cut = 0;
  const maximum = Math.max(0, messages.length - keep);
  for (let index = 0; index < maximum; index++) {
    for (const call of messages[index].tool_calls ?? []) pending.add(call.id);
    if (messages[index].role === 'tool') pending.delete(messages[index].tool_call_id);
    if (!pending.size) cut = index + 1;
  }
  return cut;
}

export function trimAgentImages(messages, supported = true) {
  let bytes = 0, count = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]; if (!Array.isArray(message.content)) continue;
    const images = message.content.filter(part => part.type === 'image_url'); if (!images.length) continue;
    bytes += images.reduce((total, part) => total + (part.image_url?.url?.length ?? 0), 0); count += images.length;
    if (!supported || count > 2 || bytes > 8 * 1024 * 1024) messages[index] = { ...message, content: message.content.filter(part => part.type !== 'image_url').map(part => part.text ?? '').join('\n') + t('agent-context.s197e146') };
  }
  return messages;
}

export const AGENT_CORE_TOOLS = new Set(['agent_tools', 'editor_context', 'editor_entities', 'editor_navigate', 'editor_source', 'chart_read', 'chart_query', 'chart_insights', 'chart_patch', 'chart_transform', 'chart_script', 'chart_templates', 'ui_inspect', 'ui_action', 'ask_user', 'web_search', 'web_fetch', 'history', 'diagnose', 'human_limits_check']);

// Tools whose results are already compact / must never be structurally trimmed
// because the agent relies on their exact shape (e.g. tool discovery).
export const AGENT_TOOL_COMPACT_EXEMPT = new Set(['agent_tools', 'chart_templates']);
