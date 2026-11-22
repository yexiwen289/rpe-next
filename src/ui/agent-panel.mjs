import { AgentCommands, AGENT_API_VERSION } from '../core/agent-commands.mjs';
import { DEFAULT_AGENT_PROMPT } from '../core/agent-prompt.mjs';
import { EditorAgent } from '../application/agent.mjs';
import { createAgentEditorCommands } from '../application/agent-editor.mjs';
import { AgentProviders, createDeepSeekProvider, createOpenAIProvider } from '../platform/agent-provider.mjs';
import { localPreferences } from '../platform/local-preferences.mjs';
import { AgentControls } from './agent-controls.mjs';
import { AgentDialogues } from './agent-dialogues.mjs';
import { AgentCredentials } from '../platform/agent-credentials.mjs';
import { AgentWorkspace } from '../platform/agent-workspace.mjs';
import { AgentCapture } from './agent-capture.mjs';
import { t } from '../i18n.mjs';
import { CUSTOM_PROVIDER_ID, CUSTOM_SETTINGS_KEY, agentCustomConfig, DEFAULT_SENSENOVA_BASE_URL, DEFAULT_SENSENOVA_MODEL, DEFAULT_SENSENOVA_API_KEY } from '../application/agent-custom-provider.mjs';
import { runtimeEnv } from '../platform/runtime-env.mjs';

const SETTINGS = 'vibephi-agent-v1';
const DEFAULT_GLM_BASE_URL = 'https://xh.v1api.cc/v1';
// 密钥来自本地 .env（RPE_GLM_API_KEY），源码中不留明文。
const DEFAULT_GLM_API_KEY = runtimeEnv('RPE_GLM_API_KEY');
const DEFAULT_GLM_MODEL = 'deepseek-v4.1-flash-1017';
export const DEFAULT_AGENT_SETTINGS = Object.freeze({ provider: 'glm', model: DEFAULT_GLM_MODEL, permission: 'full', thinking: false, maxTokens: 16384, maxRounds: 128, autoCompact: true, contextBudget: 0, fontSize: 14, rememberKey: true, timeoutMs: 300000, prompt: DEFAULT_AGENT_PROMPT, uiVersion: 6 });
export function agentSettings(saved = {}) {
  const settings = Object.fromEntries(Object.entries(DEFAULT_AGENT_SETTINGS).map(([name, fallback]) => [name, typeof saved?.[name] === typeof fallback ? saved[name] : fallback]));
  if ((saved.uiVersion ?? 0) < 4) {
    if (saved.maxRounds === 24) settings.maxRounds = 128;
    if (saved.contextBudget === 131072) settings.contextBudget = 0;
  }
  if ((saved.uiVersion ?? 0) < 5) {
    if (saved.permission === 'ask' || saved.permission === undefined) settings.permission = 'full';
    if (saved.maxTokens === 65536) settings.maxTokens = 16384;
  }
  if ((saved.uiVersion ?? 0) < 6) {
    if (saved.thinking === true) settings.thinking = false;
    if (!Number.isInteger(settings.timeoutMs) || settings.timeoutMs < 10000 || settings.timeoutMs > 900000) settings.timeoutMs = 300000;
  }
  if (!Number.isInteger(settings.maxRounds) || settings.maxRounds < 1 || settings.maxRounds > 4096) settings.maxRounds = 128;
  if (!Number.isInteger(settings.contextBudget) || settings.contextBudget !== 0 && (settings.contextBudget < 8192 || settings.contextBudget > 16777216)) settings.contextBudget = 0;
  settings.uiVersion = 6; return settings;
}
const text = (tag, value, className = '') => { const node = document.createElement(tag); node.textContent = value; node.className = className; return node; };
const button = (label, action) => { const node = text('button', label); node.type = 'button'; node.onclick = action; return node; };
const dataUrl = blob => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });

export class AgentPanel {
  constructor(editor, { activate, writeAsset, capture, notify, prependSilence }) {
    Object.assign(this, { editor, activate, notify }); this.commands = new AgentCommands(); this.providers = new AgentProviders(); this.providers.register(createDeepSeekProvider());
    this.providers.register(createOpenAIProvider({ id: 'glm', name: 'DeepSeek·中转', baseUrl: DEFAULT_GLM_BASE_URL, models: [DEFAULT_GLM_MODEL], defaultModel: DEFAULT_GLM_MODEL, capabilities: { tools: true, streaming: true, images: false, search: false, contextWindow: 1048576 } }));
    // 商汤日日新：内置第二家大模型，密钥同样来自 .env（RPE_SENSENOVA_API_KEY）。
    this.providers.register(createOpenAIProvider({ id: 'sensenova', name: '商汤 SenseNova', baseUrl: DEFAULT_SENSENOVA_BASE_URL, models: [DEFAULT_SENSENOVA_MODEL], defaultModel: DEFAULT_SENSENOVA_MODEL, capabilities: { tools: true, streaming: true, images: false, search: false, contextWindow: 1048576 }, omitThinking: true }));
    // Restore the saved custom provider synchronously: capabilities() is called
    // during construction, so the id must already exist in the registry.
    const custom = this.customConfig();
    if (custom.enabled) this.providers.upsert(this.makeCustomProvider(custom));
    let saved; try { saved = JSON.parse(localPreferences.getItem(SETTINGS) ?? '{}'); } catch { saved = {}; }
    this.settings = agentSettings(saved);
    if (!Number.isInteger(this.settings.fontSize) || this.settings.fontSize < 10 || this.settings.fontSize > 24) this.settings.fontSize = DEFAULT_AGENT_SETTINGS.fontSize;
    if (typeof saved?.prompt === 'string' && [3850, 4771, 5691, 5814, 6145, 6368, 6672, 6885, 8116, 8250].includes(saved.prompt.length)) { let fingerprint = 2166136261; for (const character of saved.prompt) fingerprint = Math.imul(fingerprint ^ character.charCodeAt(0), 16777619); if ([[3850, 2788652168], [4771, 365650397], [5691, 381708962], [5814, 3991041475], [6145, 993312695], [6368, 920097850], [6672, 694240356], [6885, 995422563], [8116, 2954976899], [8250, 3185019651]].some(([length, value]) => saved.prompt.length === length && (fingerprint >>> 0) === value)) this.settings.prompt = DEFAULT_AGENT_PROMPT; }
    if (!saved?.uiVersion && saved?.maxTokens === 8192) this.settings.maxTokens = 16384;
    this.key = ''; this.credentials = new AgentCredentials(); this.waiting = new Set(); this.host = document.querySelector('#ai-panel'); this.tab = document.querySelector('#ai-tab'); this.controls = new AgentControls();
    this.applyAppearance();
    this.dialogues = new AgentDialogues(this);
    const network = async (method, value, signal) => {
      const config = this.config(), provider = this.providers.get(config.provider); if (typeof provider[method] !== 'function') throw Error(t('agent-panel.s0b10b17'));
      const result = await provider[method](config, value, signal), encoded = JSON.stringify(result);
      return encoded.length > 45000 ? { content: encoded.slice(0, 45000), truncated: true } : result;
    };
    this.workspace = new AgentWorkspace(() => editor.agentWorkspaceId);
    this.capture = new AgentCapture({ controls: this.controls, refresh: () => editor.invalidate() });
    this.adapter = createAgentEditorCommands(this.commands, editor, { controls: this.controls, network, ask: (args, signal) => this.dialogues.ask(args, signal), capture, captureEditor: (args, signal) => this.capture.capture(args, signal), prependSilence, workspace: this.workspace });
    editor.agent = { apiVersion: AGENT_API_VERSION, commands: this.commands, providers: this.providers, allowedPanes: () => [...document.querySelectorAll('[data-panel]')].map(node => node.dataset.panel),
      capabilities: () => this.capabilities(), workspace: this.workspace, flush: () => this.flush(), dataUrl, writeAsset, open: () => this.open() };
    this.agent = new EditorAgent({ commands: this.commands, providers: this.providers, context: () => ({ session: editor.hasDocument ? editor.session : null, summary: this.adapter.summary() }),
      config: () => this.config(), approve: (plan, signal) => this.dialogues.approve(plan, signal), prompt: () => this.settings.prompt });
    this.dialogues.bind(this.agent); this.dialogues.updateStatus();
    this.credentialsReady = (this.settings.rememberKey ? this.credentials.read(this.settings.provider).then(key => { this.key = key; this.dialogues.updateStatus(); }).catch(error => this.notify(error.message, 'warning')) : Promise.resolve()).then(() => {
      if (!this.key && (this.settings.provider === 'glm' || this.settings.provider === 'sensenova')) { this.key = this.settings.provider === 'glm' ? DEFAULT_GLM_API_KEY : DEFAULT_SENSENOVA_API_KEY; this.dialogues.updateStatus(); }
      if (!this.key && this.settings.provider === CUSTOM_PROVIDER_ID) { this.key = custom.key; this.dialogues.updateStatus(); }
    });
    this.credentialsReady.then(() => this.refreshCapabilities());
    Object.defineProperty(editor.agent, 'ready', { get: () => Promise.all([this.credentialsReady, this.dialogues.ready]) });
    document.querySelector('#ai-tool').onclick = () => this.open(); if (this.tab) this.tab.onclick = () => this.open();
  }
  // --- User-configurable fallback provider ---------------------------------
  customConfig() {
    let saved = {};
    try { saved = JSON.parse(localPreferences.getItem(CUSTOM_SETTINGS_KEY) ?? '{}'); } catch { /* corrupt entry -> defaults */ }
    return agentCustomConfig(saved);
  }
  makeCustomProvider(config) {
    return createOpenAIProvider({
      id: CUSTOM_PROVIDER_ID, name: config.name || '自定义', baseUrl: config.baseUrl,
      models: [config.model], defaultModel: config.model,
      capabilities: { tools: true, streaming: true, images: false, search: false, contextWindow: config.contextWindow },
      omitThinking: !config.sendThinking,
    });
  }
  async saveCustomConfig(input, enable = true) {
    const config = agentCustomConfig({ ...input, enabled: enable });
    if (!config.baseUrl || !config.model) throw Error(t('agent-panel.sCustomIncomplete'));
    this.providers.upsert(this.makeCustomProvider(config));
    localPreferences.setItem(CUSTOM_SETTINGS_KEY, JSON.stringify(config));
    if (this.settings.rememberKey) await this.credentials.write(CUSTOM_PROVIDER_ID, config.key);
    if (enable) {
      this.settings = { ...this.settings, provider: CUSTOM_PROVIDER_ID, model: config.model };
      this.key = config.key; this.persist();
      await this.refreshCapabilities(); this.dialogues.updateStatus(); this.dialogues.updateContextUsage(); this.dialogues.refreshModelBar?.();
    }
    return config;
  }
  async useBuiltinProvider(id = 'glm') {
    if (!this.providers.entries.has(id)) id = 'deepseek';
    const config = this.customConfig();
    // Keep the custom settings saved, just disabled, so switching back is one click.
    localPreferences.setItem(CUSTOM_SETTINGS_KEY, JSON.stringify({ ...config, enabled: false }));
    const key = this.settings.rememberKey ? await this.credentials.read(id).catch(() => '') : '';
    this.settings = { ...this.settings, provider: id, model: this.providers.get(id).defaultModel ?? this.settings.model };
    this.key = key || (id === 'glm' ? DEFAULT_GLM_API_KEY : '');
    this.persist(); await this.refreshCapabilities(); this.dialogues.updateStatus(); this.dialogues.updateContextUsage(); this.dialogues.refreshModelBar?.();
    return id;
  }
  config() { const settings = this.settings; const fallbackKey = settings.provider === 'glm' ? DEFAULT_GLM_API_KEY : settings.provider === 'sensenova' ? DEFAULT_SENSENOVA_API_KEY : ''; return { ...settings, key: this.key || fallbackKey }; }
  capabilities() {
    const config = this.settings, metadata = this.modelMetadata;
    return { ...this.providers.get(config.provider).capabilities?.(config.model), ...(metadata?.provider === config.provider && metadata.model === config.model ? metadata.value : {}) };
  }
  async refreshCapabilities() {
    const config = this.config(), provider = this.providers.get(config.provider), generation = this.metadataGeneration = (this.metadataGeneration ?? 0) + 1;
    try {
      const value = config.key && provider.modelInfo ? await provider.modelInfo(config) : {};
      if (generation !== this.metadataGeneration || this.key !== config.key) return;
      this.modelMetadata = { provider: config.provider, model: config.model, value }; this.dialogues.updateContextUsage();
    } catch { if (generation === this.metadataGeneration) this.dialogues.updateContextUsage(); }
  }
  applyAppearance() { this.host.style.setProperty('--agent-font-size', this.settings.fontSize + 'px'); }
  persist() { localPreferences.setItem(SETTINGS, JSON.stringify(this.settings)); }
  // The AI chat is a sub-panel reached from「AI 工具 → 轻量 AI 修改」, not a
  // top-level tab. Never unhide #ai-tab here: doing so permanently adds a fifth
  // tab to the inspector header and only reset() ever removes it again.
  open() { this.activate('ai'); this.input.focus({ preventScroll: true }); }
  attach(workspace) { return this.dialogues.attach(workspace); }
  flush() { return this.dialogues.flush(); }
  async stopAndFlush() {
    this.dialogues.pauseQueue();
    if (this.agent.busy) await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.agent.removeEventListener('state', changed); resolve(); };
      const changed = () => { if (!this.agent.busy) finish(); }, timer = setTimeout(finish, 10000);
      this.agent.addEventListener('state', changed); this.agent.stop();
    });
    await this.flush();
  }
  reset() { this.dialogues.detach(); this.agent?.reset(); for (const finish of [...this.waiting]) finish(false); this.dialogues.reset(); if (this.tab) this.tab.hidden = true; }
  async configuration() {
    await this.credentialsReady;
    if (this.agent?.busy) return;
    this.dialog?.remove(); const dialog = document.createElement('dialog'); dialog.id = 'ai-config'; dialog.dataset.agentPrivate = 'true'; this.dialog = dialog;
    const heading = text('div', '', 'agent-heading'); heading.append(text('h2', t('agent-panel.s8717faa')), button(t('agent-panel.s6c14bd7'), () => dialog.close())); dialog.append(heading);
    const form = document.createElement('form'); form.className = 'agent-config-form';
    const field = (label, control) => { const row = text('label', label, 'field'); if (!control.hasAttribute('aria-label')) control.setAttribute('aria-label', label); row.append(control); form.append(row); return control; };
    const provider = document.createElement('select'); provider.setAttribute('aria-label', t('agent-panel.sa7836c9'));
    for (const entry of this.providers.entries.values()) { const option = text('option', entry.name); option.value = entry.id; provider.append(option); }
    provider.value = this.providers.entries.has(this.settings.provider) ? this.settings.provider : 'deepseek'; field(t('agent-panel.s4b81846'), provider);
    const model = document.createElement('input'); model.type = 'text'; model.value = this.settings.model; model.setAttribute('aria-label', t('agent-panel.s1b5fc09')); model.setAttribute('list', 'ai-model-options');
    const models = document.createElement('datalist'); models.id = 'ai-model-options';
    const fillDatalist = names => models.replaceChildren(...names.map(name => { const option = document.createElement('option'); option.value = name; return option; }));
    let modelFetchSeq = 0;
    const updateModels = async () => {
      const seq = ++modelFetchSeq, providerId = provider.value;
      const entry = this.providers.get(providerId);
      fillDatalist(entry?.models ?? []);
      if (!entry?.listModels || !key.value.trim()) return;
      try { const names = await entry.listModels({ ...this.settings, key: key.value.trim() }); if (seq === modelFetchSeq && providerId === provider.value) fillDatalist(names); }
      catch { /* 拉取失败保留内置列表，仍可手动输入 */ }
    };
    field(t('agent-panel.s98fd0cb'), model); form.append(models);
    const key = document.createElement('input'); key.type = 'password'; key.autocomplete = 'off'; key.value = this.key; key.setAttribute('aria-label', 'API Key'); field('API Key', key);
    updateModels();
    key.addEventListener('change', () => updateModels());
    const remember = document.createElement('input'); remember.type = 'checkbox'; remember.checked = this.settings.rememberKey; field(t('agent-panel.s1ea779d'), remember);
    form.append(text('p', this.credentials.bridge ? t('agent-panel.sc782ac6') : t('agent-panel.s8588e54'), 'hint'));
    const forget = button(t('agent-panel.sf1a538c'), async () => {
      forget.disabled = true;
      try { await this.credentials.write(provider.value, ''); key.value = ''; drafts.delete(provider.value); if (provider.value === this.settings.provider) { this.key = ''; this.dialogues.updateStatus(); } error.textContent = ''; this.notify(t('agent-panel.s7e8ccbc'), 'success'); }
      catch (problem) { error.textContent = problem.message; }
      finally { forget.disabled = false; }
    }); form.append(forget);
    const permission = document.createElement('select');
    for (const [value, label] of [['ask', t('agent-panel.s3b7e5f14')], ['dangerous', t('agent-panel.s5d2a8c63')], ['full', t('agent-panel.s8e1f4b07')]]) { const option = text('option', label); option.value = value; permission.append(option); }
    permission.value = this.settings.permission; field(t('agent-panel.s9a1c4d20'), permission);
    const thinking = document.createElement('input'); thinking.type = 'checkbox'; thinking.checked = this.settings.thinking; field(t('agent-panel.s51e7441'), thinking);
    const tokens = document.createElement('input'); tokens.type = 'number'; tokens.min = '1024'; tokens.max = '65536'; tokens.step = '1024'; tokens.value = this.settings.maxTokens; field(t('agent-panel.s8b2fac1'), tokens);
    const rounds = document.createElement('input'); rounds.type = 'number'; rounds.min = '1'; rounds.max = '4096'; rounds.step = '1'; rounds.value = this.settings.maxRounds; rounds.title = t('agent-panel.sb2cb09a'); field(t('agent-panel.s469251b'), rounds);
    const automatic = document.createElement('input'); automatic.type = 'checkbox'; automatic.checked = this.settings.autoCompact; field(t('agent-panel.sa1bd627'), automatic);
    const budgetMode = document.createElement('select');
    for (const [value, label] of [['auto', t('agent-panel.s073d0df')], ['custom', t('agent-panel.sc233989')]]) { const option = text('option', label); option.value = value; budgetMode.append(option); }
    budgetMode.value = this.settings.contextBudget ? 'custom' : 'auto'; field(t('agent-panel.secf753d'), budgetMode);
    const budget = document.createElement('input'); budget.type = 'number'; budget.min = '8192'; budget.max = '16777216'; budget.step = '1'; budget.value = this.settings.contextBudget || Math.floor((this.capabilities().contextWindow ?? 1048576) * 0.65); budget.title = t('agent-panel.s0ee7f16'); const budgetRow = field(t('agent-panel.sb33c938'), budget).closest('label');
    const updateBudget = () => { budgetMode.disabled = !automatic.checked; budgetRow.hidden = budgetMode.value !== 'custom'; budget.disabled = !automatic.checked || budgetMode.value !== 'custom'; }; automatic.onchange = budgetMode.onchange = updateBudget; updateBudget();
    const font = document.createElement('input'); font.type = 'number'; font.min = '10'; font.max = '24'; font.step = '1'; font.value = this.settings.fontSize; field(t('agent-panel.s0c8203a'), font);
    const instructions = document.createElement('details'); instructions.append(text('summary', t('agent-panel.s14b5be9')));
    const prompt = document.createElement('textarea'); prompt.rows = 16; prompt.className = 'agent-system-prompt'; prompt.value = this.settings.prompt; prompt.setAttribute('aria-label', t('agent-panel.s78c0792'));
    instructions.append(prompt, button(t('agent-panel.s8ea0e19'), () => { if (confirm(t('agent-panel.se2ec7fb'))) prompt.value = DEFAULT_AGENT_PROMPT; })); form.append(instructions);
    const error = text('p', '', 'agent-error'); form.append(error); const apply = button(t('agent-panel.sa0daf6d'), () => {}); apply.type = 'submit'; form.append(apply);
    const drafts = new Map(); let selectedProvider = provider.value, loading = 0;
    provider.onchange = async () => {
      drafts.set(selectedProvider, key.value); selectedProvider = provider.value; model.value = this.providers.get(provider.value).defaultModel; updateModels();
      const serial = ++loading; key.disabled = apply.disabled = forget.disabled = true;
      try { const value = drafts.has(selectedProvider) ? drafts.get(selectedProvider) : this.settings.rememberKey ? await this.credentials.read(selectedProvider) : ''; if (serial === loading) { key.value = value; if (value) updateModels(); } }
      catch (problem) { if (serial === loading) { key.value = ''; error.textContent = problem.message; } }
      finally { if (serial === loading) key.disabled = apply.disabled = forget.disabled = false; }
    };
    form.onsubmit = async event => {
      event.preventDefault(); const maxTokens = Number(tokens.value), maxRounds = Number(rounds.value), fontSize = Number(font.value), contextBudget = budgetMode.value === 'auto' ? 0 : Number(budget.value);
      if (!model.value.trim() || !prompt.value.trim() || !Number.isInteger(maxTokens) || maxTokens < 1024 || maxTokens > 65536 || !Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 4096 || !Number.isInteger(fontSize) || fontSize < 10 || fontSize > 24) { error.textContent = t('agent-panel.s3188495'); return; }
      if (!Number.isInteger(contextBudget) || contextBudget !== 0 && (contextBudget < 8192 || contextBudget > 16777216)) { error.textContent = t('agent-panel.se32854e'); return; }
      const next = { ...this.settings, provider: provider.value, model: model.value.trim(), permission: permission.value, thinking: thinking.checked, maxTokens, maxRounds, autoCompact: automatic.checked, contextBudget, fontSize, rememberKey: remember.checked, prompt: prompt.value }, apiKey = key.value.trim();
      if (key.disabled || apply.disabled) return;
      const controls = [...form.querySelectorAll('input,select,textarea,button')]; controls.forEach(control => { control.disabled = true; });
      try {
        await this.credentials.write(next.provider, next.rememberKey ? apiKey : '');
        localPreferences.setItem(SETTINGS, JSON.stringify(next)); this.settings = next; this.key = apiKey;
        this.applyAppearance(); this.dialogues.updateStatus(); this.dialogues.updateContextUsage(); this.refreshCapabilities(); this.dialogues.refreshModelBar?.(); dialog.close();
      } catch (problem) { error.textContent = problem.message; }
      finally { controls.forEach(control => { control.disabled = false; }); updateBudget(); }
    };
    dialog.append(form); document.body.append(dialog); dialog.showModal();
  }
}
