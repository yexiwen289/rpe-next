// Role definitions for the multi-agent chart collaboration pipeline.
//
// The team is a *pipeline of specialists*, not one generalist doing everything
// in a single ever-growing context. Each role runs as its own short-lived
// EditorAgent with:
//   - an isolated message history (no accumulated tool dumps),
//   - a restricted tool allow-list (roleTools) so it cannot wander,
//   - no per-role round budget (it works until it delivers its handoff),
//   - a compact handoff contract (a few lines, not a transcript).
//
// Keeping roles this small is what prevents "多个 agent 协同" from turning into
// "one very expensive context that blows up".

import { t } from '../i18n.mjs';

// `tools` is an allow-list of command names. Names must match registered tools
// in createAgentEditorCommands / the registerAgent*Tools helpers.
export const AGENT_ROLES = Object.freeze([
  {
    id: 'director',
    labelKey: 'agent-team.role.director',
    goalKey: 'agent-team.goal.director',
    tools: ['editor_context', 'chart_insights', 'diagnose', 'chart_knowledge', 'chart_tools', 'ask_user', 'web_search', 'web_fetch'],
    rounds: Infinity,
    writes: false,
  },
  {
    id: 'audio',
    labelKey: 'agent-team.role.audio',
    goalKey: 'agent-team.goal.audio',
    tools: ['editor_context', 'audio_sources', 'audio_detector', 'audio_analyze', 'audio_separate', 'audio_source', 'audio_taps', 'chart_insights', 'bpm_set', 'chart_knowledge'],
    rounds: Infinity,
    writes: false,
  },
  {
    id: 'notes',
    labelKey: 'agent-team.role.notes',
    goalKey: 'agent-team.goal.notes',
    tools: ['editor_context', 'chart_insights', 'chart_read', 'chart_query', 'chart_templates', 'chart_patch', 'chart_transform', 'chart_generate', 'chart_script', 'curve_notes', 'audio_taps', 'diagnose', 'chart_knowledge', 'history'],
    rounds: Infinity,
    writes: true,
  },
  {
    id: 'line',
    labelKey: 'agent-team.role.line',
    goalKey: 'agent-team.goal.line',
    tools: ['editor_context', 'chart_insights', 'chart_read', 'chart_query', 'line_manage', 'event_shake', 'noise_circle', 'chart_patch', 'chart_transform', 'chart_tools', 'trajectory_presets', 'trajectory_generate', 'trajectory_split', 'diagnose', 'chart_knowledge'],
    rounds: Infinity,
    writes: true,
  },
  {
    id: 'stage',
    labelKey: 'agent-team.role.stage',
    goalKey: 'agent-team.goal.stage',
    tools: ['editor_context', 'chart_insights', 'chart_read', 'chart_patch', 'chart_transform', 'preview_capture', 'editor_capture', 'editor_view', 'ui_inspect', 'ui_action', 'assets_list', 'asset_read', 'noise_fit', 'text_fit', 'global_events', 'multi_line', 'chart_knowledge'],
    rounds: Infinity,
    writes: true,
  },
  {
    id: 'review',
    labelKey: 'agent-team.role.review',
    goalKey: 'agent-team.goal.review',
    tools: ['editor_context', 'chart_insights', 'chart_read', 'chart_query', 'diagnose', 'chart_knowledge', 'chart_tools', 'history', 'preview_capture'],
    rounds: Infinity,
    writes: false,
  },
]);

export const AGENT_ROLE_IDS = Object.freeze(AGENT_ROLES.map(role => role.id));

export function agentRole(id) {
  return AGENT_ROLES.find(role => role.id === id) ?? null;
}

export function roleLabel(id) {
  const role = agentRole(id);
  return role ? t(role.labelKey) : id;
}

// Machine-parsable handoff marker. Roles are told to end their final message
// with this block; the orchestrator extracts it instead of copying the whole
// answer into the next role's context.
export const HANDOFF_OPEN = '<<<HANDOFF';
export const HANDOFF_CLOSE = 'HANDOFF>>>';

export function extractHandoff(answer, limit = 1200) {
  const raw = String(answer ?? '');
  // Some providers echo raw tool-call markup (DSML tags + script source) into
  // the assistant content; never pass that to the next role.
  const stripTags = text => text.replace(/<\/?[｜|]DSML[｜|][^>]*>/g, ' ').replace(/\r/g, '').trim();
  const stripCode = text => stripTags(text).split('\n')
    .filter(line => !/^\s*(?:const\s|let\s|var\s|for\s*\(|if\s*\(|function\s|\/\/|[{}]\s*;?\s*$)/.test(line))
    .join('\n').trim();

  const start = raw.lastIndexOf(HANDOFF_OPEN);
  let body = '';
  if (start >= 0) {
    body = raw.slice(start + HANDOFF_OPEN.length);
    const end = body.indexOf(HANDOFF_CLOSE);
    if (end >= 0) body = body.slice(0, end);
    body = stripTags(body);
  }
  // A truncated / marker-only handoff (the model emitted "<<<HANDOFF" and got
  // cut off) must not become a 10-character stub. Fall back to the model's
  // final prose before the marker, which is where the real conclusions are.
  if (body.length < 40) body = stripCode(start >= 0 ? raw.slice(0, start) : raw);
  if (!body) body = stripTags(raw);
  if (body.length > limit) body = body.slice(0, limit) + '\n…[' + t('agent-team.handoffTruncated') + ']';
  return body;
}

export function buildRoleInstruction(role, index, total) {
  const lines = [
    t('agent-team.roleInstruction', { p0: t(role.labelKey), p1: index + 1, p2: total }),
    t('agent-team.goalLabel') + t(role.goalKey),
    t('agent-team.budgetRule'),
    t('agent-team.toolRule'),
    role.writes ? t('agent-team.writeRule') : t('agent-team.readRule'),
    t('agent-team.handoffRule', { p0: HANDOFF_OPEN, p1: HANDOFF_CLOSE }),
  ];
  return lines.join('\n');
}

export function buildRoleUserText({ role, index, total, task, snapshot, handoff }) {
  const L = [];
  L.push(t('agent-team.stageHeader', { p0: index + 1, p1: total, p2: t(role.labelKey) }));
  L.push(t('agent-team.taskLabel') + task);
  if (snapshot) { L.push(''); L.push(t('agent-team.snapshotLabel')); L.push(snapshot); }
  if (handoff) { L.push(''); L.push(t('agent-team.handoffLabel')); L.push(handoff); }
  L.push('');
  L.push(t('agent-team.stageFooter'));
  return L.join('\n');
}

// A compact, plain-text snapshot derived from the shared metrics bundle. This
// replaces dumping the full metrics JSON into every role's prompt.
export function compactSnapshot(m) {
  if (!m) return '';
  const types = m.typeCounts ?? {};
  const L = [
    t('agent-team.snapshot.summary', { p0: m.totalNotes, p1: m.lineCount, p2: Number(m.duration ?? 0).toFixed(1), p3: m.bpmMin, p4: m.bpmMax }),
    t('agent-team.snapshot.types', { p0: types[1] ?? 0, p1: types[2] ?? 0, p2: types[3] ?? 0, p3: types[4] ?? 0 }),
    t('agent-team.snapshot.flags', { p0: m.above, p1: m.below, p2: m.fake, p3: m.colored, p4: m.alphaTransparent }),
    t('agent-team.snapshot.timing', { p0: m.holdCount, p1: Number(m.holdAvg ?? 0).toFixed(2), p2: Number(m.intervalMedian ?? 0).toFixed(2), p3: Number(m.intervalMax ?? 0).toFixed(2) }),
    t('agent-team.snapshot.position', { p0: Number(m.posX?.[0] ?? 0).toFixed(0), p1: Number(m.posX?.[1] ?? 0).toFixed(0), p2: m.posYCount }),
    t('agent-team.snapshot.groups', { p0: m.groupText || t('viz.none'), p1: m.fatherText || t('viz.none') }),
    t('agent-team.snapshot.events', { p0: m.eventCountsText || t('viz.none'), p1: m.eventRangeText || t('viz.none') }),
  ];
  const issues = m.issues ?? {};
  L.push(t('agent-team.snapshot.diag', { p0: issues.error ?? 0, p1: issues.warning ?? 0, p2: issues.info ?? 0 }));
  if (m.offsetBins) L.push(t('agent-team.snapshot.offset', { p0: JSON.stringify(m.offsetBins) }));
  if (m.perLineNotes) L.push(t('agent-team.snapshot.lines', { p0: JSON.stringify(m.perLineNotes.slice(0, 24)), p1: m.perLineNotes.length }));
  return L.join('\n');
}
