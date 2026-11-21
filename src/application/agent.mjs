import { AGENT_PERMISSIONS, agentAbort, checkAgentSignal } from '../core/agent-commands.mjs';
import { AGENT_CORE_TOOLS, AGENT_TOOL_COMPACT_EXEMPT, AGENT_COMPACTION_PROMPT, AGENT_MEMORY_PREFIX, compressToolResult, estimateAgentTokens, prepareAgentHistory, agentContextCut, trimAgentImages, agentContextPolicy, agentContextUsage } from '../core/agent-context.mjs';
import { t } from '../i18n.mjs';

// Tools that only work when the active provider advertises the matching
// capability. Offering them anyway makes the model spend a round on a call
// that can only fail.
const CAPABILITY_TOOLS = Object.freeze({
  search: ['web_search', 'web_fetch'],
  images: ['editor_capture', 'preview_capture'],
});

export class EditorAgent extends EventTarget {
  constructor({ commands, providers, context, config, approve, ask, prompt, now = () => performance.now() }) {
    super(); Object.assign(this, { commands, providers, context, config, approve, ask, prompt, now }); this.messages = []; this.log = []; this.busy = false; this.steering = [];
  }
  elapsedMs() { return this.busy ? Math.max(0, this.now() - this.startedClock) : this.lastDurationMs ?? 0; }
  // Team members run silently: their events must not stream into the main chat
  // panel. The orchestrator reports progress through its own callback instead.
  // Silent team runs must not dispatch into the main chat panel, but the team
  // UI still needs the tool traffic. A dedicated sink receives a side channel.
  event(type, detail) {
    if (this.silentEvents) { try { this.teamSink?.(type, detail); } catch { /* UI must never break a run */ } return; }
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
  stop() { this.controller?.abort(); }
  steer(text) {
    if (!this.busy || !text.trim()) return false;
    this.steering.push(text.trim()); if (this.requestPurpose !== 'compaction') this.requestController?.abort('steering'); this.toolController?.abort('steering'); return true;
  }
  reset() { this.stop(); this.messages = []; this.log = []; this.steering = []; this.event('reset', {}); }
  async run(text, { history, instruction = '', compactOnly = false, roleTools = null, maxRounds: roundLimit = null, silent = false, isolated = false, finalizeOnLimit = false, limitPrompt = '', teamSink = null } = {}) {
    if (this.busy) throw Error(t('agent.s358f884'));
    if (!text.trim() && !compactOnly) return;
    // A role run gets an isolated, compact history and a restricted tool list.
    // `silent` suppresses UI events; `isolated` keeps the main chat history intact.
    const previousSilent = this.silentEvents, previousSink = this.teamSink;
    this.silentEvents = Boolean(silent); this.teamSink = teamSink;
    this.roleAnswer = ''; this.roleError = null; this.limitExhausted = false;
    const commit = () => { if (!isolated) this.messages = checkpoint; };
    const config = { ...this.config() }; if (!AGENT_PERMISSIONS.includes(config.permission)) throw Error(t('agent.s8614dbf'));
    const provider = this.providers.get(config.provider); if (!config.key?.trim()) throw Error(t('agent.s4e05b06'));
    const owner = this.context().session; if (!owner) throw Error(t('agent.s21c0425'));
    const controller = new AbortController(); this.controller = controller; this.startedClock = this.now(); this.busy = true; this.steering = [];
    const runId = crypto.randomUUID();
    let messages = prepareAgentHistory(history ?? this.messages), transcript = [], checkpoint = structuredClone(messages), checkpointTranscript = [], compacted = false;
    if (!compactOnly) { const user = { role: 'user', content: text }; messages.push(user); transcript.push(user); checkpoint = structuredClone(messages); checkpointTranscript = structuredClone(transcript); }
    this.turnMessages = checkpointTranscript;
    const statistics = { model: config.model, provider: provider.name ?? config.provider, startedAt: Date.now(), durationMs: 0, requestMs: 0, requests: 0, tools: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedTokens: 0, usageKnown: false, compactions: 0 };
    let status = 'failed', success = false, system = '', lastRequestMs = 0, currentInstruction = text;
    const guard = () => this.context().session === owner && !controller.signal.aborted;
    const redact = value => JSON.parse(JSON.stringify(value, (name, entry) => typeof entry === 'string' ? entry.replaceAll(config.key, '[已隐藏]') : entry));
    let capabilities = provider.capabilities?.(config.model) ?? {};
    const roleAllow = roleTools?.length ? new Set(roleTools) : null;
    const selectedTools = roleAllow ? new Set(roleAllow) : new Set(AGENT_CORE_TOOLS);
    for (const message of messages) for (const call of message.tool_calls ?? []) if (call.function?.name) selectedTools.add(call.function.name);
    const tools = () => {
      const all = this.commands.tools();
      const list = roleAllow || this.commands.entries.has('agent_tools') ? all.filter(tool => selectedTools.has(tool.function.name)) : all;
      return list.filter(tool => {
        const name = tool.function.name;
        if (!capabilities.search && CAPABILITY_TOOLS.search.includes(name)) return false;
        if (!capabilities.images && CAPABILITY_TOOLS.images.includes(name)) return false;
        return true;
      });
    };
    let policy = agentContextPolicy(config, capabilities), budget = policy.threshold;
    const reportContext = (tokens = estimateAgentTokens({ system, tools: tools(), messages }), estimated = true) => {
      this.contextUsage = agentContextUsage(tokens, { ...policy, threshold: budget }, estimated); this.event('context-usage', this.contextUsage);
    };
    const usage = response => {
      statistics.model = response.model ?? config.model;
      if (!response.usage) return;
      const value = response.usage; statistics.usageKnown = true;
      statistics.promptTokens += value.prompt_tokens ?? 0; statistics.completionTokens += value.completion_tokens ?? 0;
      statistics.totalTokens += value.total_tokens ?? (value.prompt_tokens ?? 0) + (value.completion_tokens ?? 0);
      statistics.reasoningTokens += value.completion_tokens_details?.reasoning_tokens ?? 0;
      statistics.cachedTokens += value.prompt_cache_hit_tokens ?? value.prompt_tokens_details?.cached_tokens ?? 0;
    };
    const invoke = async (request, purpose) => {
      checkAgentSignal(controller.signal); if (!guard()) throw agentAbort();
      const requestController = new AbortController(); this.requestController = requestController; this.requestPurpose = purpose;
      const signal = AbortSignal.any([controller.signal, requestController.signal]), startedAt = Date.now(), startedClock = this.now();
      const exchange = { id: crypto.randomUUID(), purpose, startedAt, status: 'running', model: config.model, provider: config.provider,
        request: { system: request.system, messages: structuredClone(request.messages), tools: request.tools, maxTokens: request.config.maxTokens }, response: null };
      statistics.requests++; this.event('exchange-start', redact(exchange));
      if (purpose === 'chat') this.event('assistant-start', { model: config.model, startedAt });
      const inputTokens = purpose === 'chat' ? estimateAgentTokens({ system: request.system, tools: request.tools, messages: request.messages }) : 0;
      let streamedTokens = 0, lastMeterClock = this.now();
      const streamUsage = delta => { if (purpose !== 'chat') return; streamedTokens += estimateAgentTokens(delta); if (this.now() - lastMeterClock >= 250) { reportContext(inputTokens + streamedTokens); lastMeterClock = this.now(); } };
      try {
        const response = await provider.complete({ ...request, signal, exchangeId: exchange.id,
          onTrace: trace => { if (trace.request) exchange.request = trace.request; if (trace.response) exchange.response = trace.response; },
          onText: delta => { if (purpose === 'chat') this.event('text', { delta }); streamUsage(delta); },
          onReasoning: delta => { if (purpose === 'chat') this.event('reasoning', { delta }); streamUsage(delta); },
        });
        if (signal.aborted) throw agentAbort();
        exchange.status = 'completed'; exchange.response ??= { assistant: structuredClone(response) }; usage(response); return response;
      } catch (error) {
        exchange.status = controller.signal.aborted ? 'stopped' : requestController.signal.aborted ? 'interrupted' : 'failed';
        exchange.error = String(error.message); exchange.response ??= { status: error.status, body: error.responseBody ?? null };
        if (purpose === 'chat') this.event('assistant-cancelled', { reason: exchange.status });
        throw error;
      } finally {
        exchange.durationMs = Math.max(0, this.now() - startedClock); lastRequestMs = exchange.durationMs; statistics.requestMs += exchange.durationMs;
        this.event('exchange-end', redact(exchange)); if (this.requestController === requestController) this.requestController = null;
      }
    };
    const compress = async force => {
      const currentTools = tools(), before = estimateAgentTokens({ system, tools: currentTools, messages });
      if (!force && before <= budget) return false;
      let cut = agentContextCut(messages, force ? 4 : 10);
      if (!cut) cut = agentContextCut(messages, 1);
      if (!cut) return false;
      const reserve = Math.min(8192, Math.max(1024, Math.floor(budget / 8)));
      if (estimateAgentTokens({ system, tools: currentTools, messages: messages.slice(cut) }) + reserve > budget) cut = agentContextCut(messages, 1) || cut;
      if (estimateAgentTokens({ system, tools: currentTools, messages: messages.slice(cut) }) + reserve > budget && cut < messages.length) cut = agentContextCut(messages, 0) || cut;
      this.event('compaction-start', { beforeTokens: before });
      const prefix = prepareAgentHistory(messages.slice(0, cut), { preserveToolReasoning: false });
      const source = JSON.stringify(prefix, (key, value) => key === 'image_url' ? '[历史图像：需要时重新取图]' : value);
      const chunkSize = Math.max(4096, Math.min(120000, Math.floor((budget - 6000) * 1.5))); let summary = '';
      for (let offset = 0; offset < source.length; offset += chunkSize) {
        const response = await invoke({ config: { ...config, thinking: false, maxTokens: Math.min(8192, config.maxTokens ?? 8192) }, system: AGENT_COMPACTION_PROMPT,
          messages: [{ role: 'user', content: t('agent.sf8046ce') + summary + t('agent.s7cec8d2') + source.slice(offset, offset + chunkSize) }], tools: [] }, 'compaction');
        summary = response.content?.trim() ?? ''; if (!summary) throw Error(t('agent.sfde1bae'));
      }
      const retained = messages.slice(cut);
      if (!retained.length && !compactOnly) retained.push({ role: 'user', content: currentInstruction });
      messages = [{ role: 'user', content: AGENT_MEMORY_PREFIX + summary }, ...retained];
      compacted = true; statistics.compactions++;
      this.event('compaction-end', { summary, beforeTokens: before, afterTokens: estimateAgentTokens({ system, tools: currentTools, messages }) }); reportContext();
      checkpoint = structuredClone(messages); return true;
    };
    const steer = () => {
      for (const value of this.steering.splice(0)) { currentInstruction = value; const message = { role: 'user', content: value }; messages.push(message); transcript.push(message); this.event('steering', { text: value }); }
      checkpoint = structuredClone(messages); checkpointTranscript = structuredClone(transcript);
      this.turnMessages = checkpointTranscript;
    };
    this.log.push({ role: 'user', text }); this.event('user', { text, runId, startedAt: statistics.startedAt }); this.event('state', { busy: true });
    try {
      if (provider.modelInfo) { try { capabilities = { ...capabilities, ...await provider.modelInfo(config, { signal: controller.signal }) }; } catch (error) { checkAgentSignal(controller.signal); } }
      policy = agentContextPolicy(config, capabilities); budget = policy.threshold;
      trimAgentImages(messages, Boolean(capabilities.images)); checkpoint = structuredClone(messages);
      system = this.prompt() + t('agent.s1f13b73') + JSON.stringify(this.context().summary) + t('agent.s112fe43') + config.permission + t('agent.s2078fe0') + JSON.stringify(capabilities) + '\n' + instruction;
      reportContext();
      if (compactOnly) {
        await compress(true);
        if (!this.steering.length) { checkpoint = structuredClone(messages); commit(); success = true; status = 'completed'; this.event('compaction-only', { text: compacted ? t('agent.sfd58576') : t('agent.sfe0bbd6') }); return; }
        steer(); compactOnly = false;
      }
      // Team roles request Infinity: they keep working until they actually
      // deliver their handoff, with no per-role round budget. A finite value
      // still applies to normal user chats (config.maxRounds).
      const requestedRounds = roundLimit ?? config.maxRounds ?? 128;
      const maxRounds = requestedRounds === Infinity ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.min(4096, requestedRounds));
      let repaired = false;
      for (let round = 0; round < maxRounds; round++) {
        checkAgentSignal(controller.signal); if (!guard()) throw Error(t('agent.s5d3d59b'));
        if (this.steering.length) steer();
        if (policy.automatic) await compress(false);
        if (this.steering.length) steer();
        reportContext();
        this.event('round', { round: round + 1, maximum: maxRounds });
        let response;
        try { response = await invoke({ config, system, messages, tools: tools() }, 'chat'); }
        catch (error) {
          if (!controller.signal.aborted && this.steering.length) { steer(); continue; }
          if (policy.automatic && !repaired && !controller.signal.aborted && /context|上下文|token.*(?:limit|exceed)|maximum.*token/i.test(String(error.responseBody ?? error.message))) { repaired = true; budget = Math.max(8192, Math.floor(budget / 2)); if (await compress(true)) continue; }
          throw error;
        }
        if (!guard()) throw agentAbort();
        const { usage: tokenUsage, model, ...assistant } = response;
        messages.push(assistant); transcript.push(assistant); this.log.push({ role: 'assistant', text: assistant.content ?? '' });
        reportContext(Number.isFinite(tokenUsage?.prompt_tokens) ? tokenUsage.prompt_tokens + (tokenUsage.completion_tokens ?? 0) : undefined, !Number.isFinite(tokenUsage?.prompt_tokens));
        this.event('assistant-end', { text: assistant.content ?? '', reasoning: assistant.reasoning_content ?? '', final: !assistant.tool_calls?.length, model: model ?? config.model, usage: tokenUsage, durationMs: lastRequestMs });
        if (!assistant.tool_calls?.length) {
          this.roleAnswer = assistant.content ?? '';
          checkpoint = structuredClone(messages); checkpointTranscript = structuredClone(transcript);
          this.turnMessages = checkpointTranscript;
          if (this.steering.length) { steer(); continue; }
          success = true; status = 'completed'; commit(); return;
        }
        const images = [];
        for (const call of assistant.tool_calls) {
          checkAgentSignal(controller.signal); if (!guard()) throw agentAbort();
          let result; statistics.tools++;
          const toolController = new AbortController(); this.toolController = toolController;
          try {
            const args = JSON.parse(call.function.arguments); this.event('tool-start', { id: call.id, name: call.function.name, arguments: args });
            if (this.steering.length) result = { ok: false, cancelled: true, message: t('agent.sd7980bb') };
            else result = await this.commands.execute(call.function.name, args, { permission: config.permission, approve: this.approve, signal: AbortSignal.any([controller.signal, toolController.signal]), guard });
            if (toolController.signal.aborted && this.steering.length) result = { ok: false, cancelled: true, message: t('agent.s7c678e4') };
          } catch (error) {
            if (controller.signal.aborted) throw error;
            result = { ok: false, cancelled: toolController.signal.aborted, error: String(error.message).replaceAll(config.key, '[已隐藏]') };
          } finally { if (this.toolController === toolController) this.toolController = null; }
          if (!roleAllow && call.function.name === 'agent_tools' && result.ok) for (const entry of result.result?.commands ?? []) selectedTools.add(entry.name);
          const image = result.result?.image; if (image) delete result.result.image;
          // Keep the full result for the UI event / tool log, but push a
          // structurally compacted version into the model context. This is the
          // main defence against a few verbose tools exhausting the window.
          const full = JSON.stringify(result);
          const exempt = AGENT_TOOL_COMPACT_EXEMPT.has(call.function.name);
          const compacted = exempt ? { text: full, compressed: false, originalChars: full.length } : compressToolResult(result, { maxChars: Math.max(800, Number(config.toolResultBudget) || 6000) });
          const content = compacted.text.length > 60000 ? JSON.stringify({ ok: false, error: t('agent.s7497cbc'), characters: compacted.text.length }) : compacted.text;
          const message = { role: 'tool', tool_call_id: call.id, content };
          messages.push(message); transcript.push(message);
          this.log.push({ role: 'tool', name: call.function.name, text: content });
          this.event('tool-end', { id: call.id, name: call.function.name, result, compressed: compacted.compressed, originalChars: compacted.originalChars });
          if (image && capabilities.images) images.push({ role: 'user', content: [{ type: 'text', text: t('agent.sa72ef18') + call.function.name + t('agent.s4d1f0a3') }, { type: 'image_url', image_url: { url: image } }] });
        }
        messages.push(...images); transcript.push(...images);
        trimAgentImages(messages, Boolean(capabilities.images));
        checkpoint = structuredClone(messages); commit(); checkpointTranscript = structuredClone(transcript);
        this.turnMessages = checkpointTranscript;
        if (this.steering.length) steer();
      }
      // A team member that runs out of tool rounds must not be reported as a
      // failure: its edits are already on the chart and the next role needs
      // what it learned. Ask for one final, tool-free handoff instead.
      if (finalizeOnLimit) {
        const prompt = limitPrompt || 'Tool rounds exhausted. Output a short final handoff now, with no tool calls.';
        let summary = '';
        try {
          const response = await invoke({
            // A handoff needs real content; do not let a tiny output cap cut
            // it off after the opening marker.
            config: { ...config, thinking: false, maxTokens: Math.max(4096, Math.min(16384, config.maxTokens ?? 8192)) },
            system: system + '\n' + prompt,
            messages: [...messages, { role: 'user', content: prompt }],
            tools: [],
          }, 'chat');
          summary = String(response.content ?? '').trim();
        } catch { /* network/context failure: reuse the last assistant text instead */ }
        if (!summary) for (let index = messages.length - 1; index >= 0; index--) {
          const entry = messages[index];
          if (entry.role === 'assistant' && typeof entry.content === 'string' && entry.content.trim()) { summary = entry.content.trim(); break; }
        }
        if (summary) {
          this.roleAnswer = summary; this.limitExhausted = true;
          messages.push({ role: 'assistant', content: summary }); transcript.push({ role: 'assistant', content: summary });
          checkpoint = structuredClone(messages); checkpointTranscript = structuredClone(transcript);
          this.turnMessages = checkpointTranscript; commit();
          success = true; status = 'completed';
          return;
        }
      }
      throw Error(t('agent.se4c2f89'));
    } catch (error) {
      const message = controller.signal.aborted ? t('agent.sa3e2c2f') : String(error.message).replaceAll(config.key, '[已隐藏]');
      status = controller.signal.aborted ? 'stopped' : 'failed'; this.event('error', { message, aborted: controller.signal.aborted }); this.log.push({ role: 'error', text: message });
      if (this.context().session === owner) commit();
      this.roleError = message;
    } finally {
      statistics.durationMs = this.lastDurationMs = this.elapsedMs(); this.busy = false; this.controller = this.requestController = this.toolController = null;
      // Keep suppressing events until AFTER the final ones are emitted: a
      // silent team run must not leak turn-end/state into the main chat panel.
      this.event('turn-end', { runId, status, statistics, messages: structuredClone(checkpointTranscript), contextMessages: structuredClone(checkpoint), contextUsage: this.contextUsage, compacted });
      this.event('state', { busy: false, success });
      this.silentEvents = previousSilent; this.teamSink = previousSink;
    }
  }
}
