// "AI 工具" panel — a peer of 谱面可视化 in the chart-tools tab.
//
// Exactly three entries:
//   1. AI 谱面分析   — single-agent, read-only report from aggregated metrics.
//   2. 轻量 AI 修改  — opens the AI chat (#ai-tool, wired by AgentPanel).
//   3. 多 Agent 协作 — expands the six-role team pipeline.
//
// The old「AI 优化谱面」entry was removed: it overlapped with the lightweight
// AI edit entry and produced a second, conflicting "improve chart" workflow.

import { t } from '../i18n.mjs';
import { computeChartMetrics } from '../core/chart-metrics.mjs';
import { computeWorkflowMetrics, generateObservations, runAgentChartWorkflow } from './agent-chart-workflow.mjs';
import { AGENT_ROLES, roleLabel } from '../application/agent-roles.mjs';
import { agentTeamReady, runAgentTeam, stopAgentTeam, teamReport } from '../application/agent-team.mjs';
import { AGENT_CUSTOM_PRESETS, CUSTOM_PROVIDER_ID } from '../application/agent-custom-provider.mjs';

let lastComputed = null;
let lastAgent = null;

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildConfigSection(agentPanel) {
  const box = make('details', 'ai-config-section');
  box.append(make('summary', '', t('viz.aiConfigTitle')));
  box.append(make('p', 'hint', t('viz.aiConfigIntro')));

  const current = make('div', 'ai-config-current');
  box.append(current);
  const refresh = () => {
    const provider = agentPanel?.settings?.provider ?? '—';
    const label = provider === CUSTOM_PROVIDER_ID ? (agentPanel?.customConfig?.().name || '自定义') : provider;
    current.textContent = t('viz.aiConfigCurrent', { p0: label, p1: agentPanel?.settings?.model ?? '—' });
  };

  const control = (type, value, extra = {}) => {
    const node = document.createElement('input');
    node.type = type; node.value = value ?? '';
    Object.assign(node, extra);
    return node;
  };
  const row = (label, node) => {
    const wrap = make('label', 'ai-config-field');
    wrap.append(make('span', '', label), node);
    box.append(wrap);
    return node;
  };

  const preset = document.createElement('select');
  for (const entry of AGENT_CUSTOM_PRESETS) {
    const option = document.createElement('option');
    option.value = entry.id; option.textContent = t(entry.nameKey);
    preset.append(option);
  }
  row(t('viz.aiConfigPreset'), preset);

  const saved = agentPanel?.customConfig?.() ?? AGENT_CUSTOM_PRESETS[0];
  const nameInput = control('text', saved.name);
  const urlInput = control('url', saved.baseUrl, { placeholder: 'https://…/v1' });
  const modelInput = control('text', saved.model);
  const keyInput = control('password', saved.key, { autocomplete: 'off' });
  const ctxInput = control('number', saved.contextWindow, { min: '8192', max: '16777216', step: '1024' });
  const thinkInput = document.createElement('input');
  thinkInput.type = 'checkbox'; thinkInput.checked = Boolean(saved.sendThinking);
  row(t('viz.aiConfigName'), nameInput);
  row(t('viz.aiConfigBaseUrl'), urlInput);
  row(t('viz.aiConfigModel'), modelInput);
  row(t('viz.aiConfigKey'), keyInput);
  row(t('viz.aiConfigContext'), ctxInput);
  const thinkRow = row(t('viz.aiConfigThinking'), thinkInput);
  thinkRow.className = 'ai-config-field ai-config-check';

  const matched = AGENT_CUSTOM_PRESETS.find(entry => entry.baseUrl === saved.baseUrl && entry.model === saved.model);
  preset.value = matched?.id ?? 'blank';
  preset.onchange = () => {
    const entry = AGENT_CUSTOM_PRESETS.find(item => item.id === preset.value);
    if (!entry) return;
    nameInput.value = entry.name; urlInput.value = entry.baseUrl;
    modelInput.value = entry.model; keyInput.value = entry.key;
    ctxInput.value = String(entry.contextWindow);
    thinkInput.checked = Boolean(entry.sendThinking);
  };

  const actions = make('div', 'ai-config-actions');
  const status = make('span', 'viz-status');
  const saveEnable = make('button', 'viz-ai-button', t('viz.aiConfigSaveEnable'));
  const saveOnly = make('button', '', t('viz.aiConfigSaveOnly'));
  const builtin = make('button', '', t('viz.aiConfigBuiltin'));
  actions.append(saveEnable, saveOnly, builtin, status);
  box.append(actions);

  const values = () => ({
    name: nameInput.value, baseUrl: urlInput.value, model: modelInput.value,
    key: keyInput.value, contextWindow: Number(ctxInput.value),
    sendThinking: thinkInput.checked,
  });
  const save = async enable => {
    if (!agentPanel?.saveCustomConfig) { status.textContent = t('viz.aiNoAgent'); return; }
    try { await agentPanel.saveCustomConfig(values(), enable); status.textContent = t('viz.aiConfigSaved'); refresh(); }
    catch (error) { status.textContent = t('viz.aiConfigError', { p0: error?.message || String(error) }); }
  };
  saveEnable.onclick = () => save(true);
  saveOnly.onclick = () => save(false);
  builtin.onclick = async () => {
    if (!agentPanel?.useBuiltinProvider) { status.textContent = t('viz.aiNoAgent'); return; }
    try { await agentPanel.useBuiltinProvider('glm'); status.textContent = t('viz.aiConfigSaved'); refresh(); }
    catch (error) { status.textContent = t('viz.aiConfigError', { p0: error?.message || String(error) }); }
  };
  if (!agentPanel) { saveEnable.disabled = saveOnly.disabled = builtin.disabled = true; status.textContent = t('viz.aiNoAgent'); }
  refresh();
  return box;
}

function buildTeamSection(agentPanel, metrics) {
  const section = make('section', 'team-section');
  section.append(make('h4', 'team-heading', t('agent-team.title')));
  section.append(make('p', 'hint', t('agent-team.intro')));

  const pipeline = make('div', 'team-pipeline');
  // Each card is clickable: it expands a live feed of that role's tool calls,
  // results and final answer. The team run stays silent w.r.t. the main chat.
  const cards = AGENT_ROLES.map((role, index) => {
    const wrap = make('div', 'team-role-wrap');
    const card = make('div', 'team-role');
    card.dataset.role = role.id;
    card.title = t('agent-team.showDetail');
    card.append(make('span', 'team-role-index', String(index + 1)));
    const body = make('div', 'team-role-body');
    body.append(make('strong', '', roleLabel(role.id)));
    body.append(make('small', '', t(role.goalKey)));
    card.append(body);
    const state = make('span', 'team-role-state', t('agent-team.pending'));
    card.append(state);

    const detail = make('div', 'team-role-detail');
    detail.hidden = true;
    const badge = make('span', 'team-role-badge', t('agent-team.noToolCalls'));
    const events = make('div', 'team-events');
    const output = make('pre', 'team-role-output');
    output.hidden = true;
    detail.append(badge, events, output);
    wrap.append(card, detail);
    pipeline.append(wrap);

    card.onclick = () => {
      detail.hidden = !detail.hidden;
      card.dataset.expanded = String(!detail.hidden);
    };
    return { card, state, detail, badge, events, output, count: 0 };
  });
  section.append(pipeline);

  section.append(make('label', 'team-label', t('agent-team.taskLabel')));
  const input = make('textarea', 'team-task');
  input.rows = 3;
  input.value = t('agent-team.defaultTask');
  input.placeholder = t('agent-team.taskPlaceholder');
  section.append(input);

  const controls = make('div', 'viz-toolbar team-controls');
  const launch = make('button', 'viz-ai-button team-launch', t('agent-team.launch'));
  const stop = make('button', 'team-stop', t('agent-team.stop'));
  stop.disabled = true;
  const status = make('span', 'viz-status');
  controls.append(launch, stop, status);
  section.append(controls);

  const log = make('div', 'team-log');
  section.append(log);
  const report = make('pre', 'team-report');
  report.hidden = true;
  section.append(report);

  const setState = (entry, state, text) => {
    entry.card.dataset.state = state;
    entry.state.textContent = text;
  };
  const resetDetail = entry => {
    entry.events.replaceChildren();
    entry.output.textContent = ''; entry.output.hidden = true;
    entry.count = 0; entry.badge.textContent = t('agent-team.noToolCalls');
  };
  const appendEvent = (entry, item) => {
    const row = make('div', 'team-event');
    row.dataset.status = item.status || 'info';
    const head = make('div', 'team-event-head');
    head.title = t('agent-team.showFull');
    const glyph = item.kind === 'tool-start' ? '▶' : item.kind === 'tool-end' ? '✔' : '·';
    head.append(make('span', 'team-event-glyph', glyph));
    head.append(make('strong', '', item.label));
    if (item.summary) head.append(make('span', 'team-event-summary', item.summary));
    const full = make('pre', 'team-event-full', item.full || '');
    full.hidden = true;
    head.onclick = () => { full.hidden = !full.hidden; };
    row.append(head, full);
    entry.events.append(row);
    if (item.kind === 'tool-start') {
      entry.count++;
      entry.badge.textContent = t('agent-team.toolCalls', { p0: entry.count });
    }
    entry.detail.scrollTop = entry.detail.scrollHeight;
    return row;
  };
  const line = text => {
    const row = make('div', 'team-log-line', text);
    log.append(row); log.scrollTop = log.scrollHeight;
    return row;
  };

  if (!agentTeamReady(agentPanel)) {
    launch.disabled = true;
    status.textContent = t('agent-team.noAgent');
  }

  let running = false;
  let controller = null;
  stop.onclick = () => { controller?.abort(); stopAgentTeam(agentPanel); status.textContent = t('agent-team.stopping'); };

  launch.onclick = async () => {
    if (running) return;
    running = true; launch.disabled = true; stop.disabled = false;
    controller = new AbortController();
    log.replaceChildren(); report.hidden = true;
    for (const entry of cards) { setState(entry, 'pending', t('agent-team.pending')); resetDetail(entry); }
    status.textContent = t('agent-team.running');
    try {
      const result = await runAgentTeam({
        agentPanel,
        task: input.value,
        metrics,
        signal: controller.signal,
        onStage: event => {
          const entry = cards[event.index];
          if (!entry) return;
          if (event.type === 'start') {
            setState(entry, 'active', t('agent-team.active'));
            status.textContent = t('agent-team.stage', { p0: event.index + 1, p1: event.total, p2: event.label });
            line(t('agent-team.stageLog', { p0: event.index + 1, p1: event.total, p2: event.label }));
          } else if (event.type === 'event') {
            appendEvent(entry, event.event);
          } else {
            setState(entry, event.ok ? 'done' : 'error', event.ok ? t('agent-team.done') : t('agent-team.failed'));
            if (event.handoff) {
              entry.output.textContent = t('agent-team.finalOutput') + '\n' + event.handoff;
              entry.output.hidden = false;
            }
            if (event.error) line(t('agent-team.errorLog', { p0: event.label, p1: event.error }));
            else line(t('agent-team.doneLog', { p0: event.label, p1: event.handoff?.length ?? 0 }));
          }
        },
      });
      report.textContent = teamReport(result);
      report.hidden = false;
      status.textContent = result.stopped ? t('agent-team.stopped') : result.ok ? t('agent-team.completed') : t('agent-team.partial');
    } catch (error) {
      status.textContent = t('agent-team.errorLog', { p0: t('agent-team.title'), p1: error?.message || String(error) });
      line(status.textContent);
    } finally {
      running = false; launch.disabled = false; stop.disabled = true;
      for (const entry of cards) if (entry.card.dataset.state === 'active') setState(entry, 'error', t('agent-team.failed'));
    }
  };

  return section;
}

export function renderChartAiTools(host, args) {
  // #ai-tool is a static element also referenced by editor skins, screenshot
  // privacy filters and protected controls. Keep the exact node on every
  // re-render — its onclick is wired by AgentPanel at construction time and
  // must never be replaced.
  const aiToolButton = host.querySelector('#ai-tool') ?? document.querySelector('#ai-tool');
  host.replaceChildren();

  const chart = args?.chart;
  if (!chart || !(chart.judgeLineList ?? []).length) {
    host.append(make('p', 'hint', t('viz.empty')));
    if (aiToolButton) host.append(aiToolButton);
    return;
  }

  const { tempo, agent } = args;
  lastAgent = agent ?? null;
  lastComputed = computeWorkflowMetrics(chart, tempo);
  const m = computeChartMetrics(chart, tempo);

  // --- The three entries ---
  const grid = make('div', 'ai-tools-grid');
  const statusEl = make('span', 'viz-status ai-tools-status');

  const analyzeBtn = make('button', 'ai-tools-button', t('viz.aiAnalyze'));
  analyzeBtn.disabled = !lastAgent;
  analyzeBtn.onclick = () => runAgentChartWorkflow({ agent: lastAgent, metrics: lastComputed, statusEl });
  grid.append(analyzeBtn);

  if (aiToolButton) {
    aiToolButton.classList.remove('wide-button', 'light-open');
    aiToolButton.classList.add('ai-tools-button');
    grid.append(aiToolButton);
  }

  const teamBtn = make('button', 'ai-tools-button ai-tools-team-button', t('viz.aiTeamEntry'));
  grid.append(teamBtn);
  host.append(grid, statusEl);

  host.append(make('p', 'hint', t('viz.aiToolsIntro', { p0: m.totalNotes, p1: m.lineCount, p2: m.duration.toFixed(1) })));
  host.append(buildConfigSection(lastAgent));

  // --- Offline preview (works without an API key) ---
  const observations = generateObservations(lastComputed);
  if (observations.length) {
    host.append(make('h4', '', t('viz.aiPreview')));
    const list = make('ul', 'viz-observations');
    for (const text of observations) list.append(make('li', '', text));
    host.append(list);
  }

  // --- Team pipeline, revealed by the third button ---
  const teamSection = buildTeamSection(lastAgent, lastComputed);
  teamSection.hidden = true;
  host.append(teamSection);
  teamBtn.onclick = () => {
    teamSection.hidden = !teamSection.hidden;
    teamBtn.dataset.expanded = String(!teamSection.hidden);
    if (!teamSection.hidden) teamSection.scrollIntoView?.({ block: 'nearest' });
  };
}
