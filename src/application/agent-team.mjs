// Multi-agent chart collaboration pipeline.
//
// Instead of one generalist agent accumulating a huge transcript, the task is
// split across six specialists. Every specialist is a *short-lived, isolated*
// run of the same EditorAgent instance:
//
//   history: []      -> no inherited tool dumps from earlier roles
//   roleTools: [...] -> only the tools that role is allowed to use
//   maxRounds: N     -> hard cap on tool chatter
//   silent: true     -> does not stream into the main chat panel
//   isolated: true   -> does not overwrite the main conversation history
//
// Roles communicate only through a compact HANDOFF block (<=1200 chars). That
// is the key to "多个 agent 协同" without multiplying the context cost.
//
// Writes happen on the real editor session, so by the time the review role
// starts it sees the chart the earlier roles actually produced.

import { t } from '../i18n.mjs';
import { AGENT_ROLES, buildRoleInstruction, buildRoleUserText, compactSnapshot, extractHandoff, roleLabel } from './agent-roles.mjs';

// Turn the engine's raw event stream into small, displayable rows. Streaming
// deltas, token meters and exchange traces are dropped — only tool traffic and
// final answers matter when inspecting a role.
const TEAM_EVENT_TYPES = new Set(['tool-start', 'tool-end', 'assistant-end', 'error', 'steering']);

export function compactTeamEvent(type, detail = {}) {
  if (!TEAM_EVENT_TYPES.has(type)) return null;
  const stringify = value => { try { return JSON.stringify(value) ?? ''; } catch { return String(value); } };
  const clip = (value, length) => { const text = String(value ?? ''); return text.length > length ? text.slice(0, length) + '…' : text; };
  let label = '', summary = '', status = 'info';
  if (type === 'tool-start') {
    label = detail.name ?? 'tool';
    summary = clip(stringify(detail.arguments), 260);
    status = 'call';
  } else if (type === 'tool-end') {
    const ok = detail.result?.ok !== false;
    label = detail.name ?? 'tool';
    summary = clip(stringify(detail.result), 300);
    status = ok ? 'ok' : 'error';
    if (detail.compressed) summary += t('agent-team.eventCompressed', { p0: detail.originalChars ?? 0 });
  } else if (type === 'assistant-end') {
    label = t('agent-team.eventOutput');
    summary = clip(detail.text, 300);
    status = detail.final ? 'ok' : 'info';
  } else if (type === 'error') {
    label = t('agent-team.eventError');
    summary = clip(detail.message, 300);
    status = 'error';
  } else {
    label = t('agent-team.eventSteering');
    summary = clip(detail.text, 200);
  }
  return { kind: type, label, summary, status, full: clip(stringify(detail), 8000) };
}

export function agentTeamReady(agentPanel) {
  return Boolean(agentPanel?.agent && typeof agentPanel.agent.run === 'function');
}

export function stopAgentTeam(agentPanel) {
  try { agentPanel?.agent?.stop(); } catch { /* already stopped */ }
}

/**
 * @param {object}   options
 * @param {object}   options.agentPanel  the AgentPanel singleton (app.mjs)
 * @param {string}   options.task        user's goal in natural language
 * @param {object}   options.metrics     output of computeWorkflowMetrics()
 * @param {function} options.onStage     ({type,index,total,id,label,...}) => void
 * @param {AbortSignal} [options.signal]
 */
export async function runAgentTeam({ agentPanel, task, metrics, onStage, signal } = {}) {
  const engine = agentPanel?.agent;
  if (!engine || typeof engine.run !== 'function') throw Error(t('agent-team.noAgent'));
  const goal = String(task ?? '').trim() || t('agent-team.defaultTask');
  const total = AGENT_ROLES.length;
  const snapshot = compactSnapshot(metrics);
  const stages = [];
  let handoff = '';
  let stopped = false;

  const emit = detail => { try { onStage?.(detail); } catch { /* UI callback must not break the pipeline */ } };
  const abortCheck = () => {
    if (!signal?.aborted) return false;
    stopped = true; return true;
  };

  for (let index = 0; index < total; index++) {
    if (abortCheck()) break;
    const role = AGENT_ROLES[index];
    const label = roleLabel(role.id);
    emit({ type: 'start', index, total, id: role.id, label, handoffChars: handoff.length });

    // The snapshot is only injected once. Later roles rely on their own reads
    // plus the tiny handoff, so context size stays flat across the pipeline.
    const text = buildRoleUserText({
      role, index, total, task: goal,
      snapshot: index === 0 ? snapshot : '',
      handoff,
    });

    engine.roleAnswer = ''; engine.roleError = null;
    let error = '';
    try {
      await engine.run(text, {
        history: [],
        instruction: buildRoleInstruction(role, index, total),
        roleTools: role.tools,
        maxRounds: role.rounds,
        silent: true,
        isolated: true,
        // Never lose a role's work when it exhausts its tool budget: ask for a
        // final handoff instead of throwing, so the pipeline can continue.
        finalizeOnLimit: true,
        limitPrompt: t('agent-team.limitFinalize'),
        teamSink: (eventType, detail) => {
          const item = compactTeamEvent(eventType, detail);
          if (item) emit({ type: 'event', index, total, id: role.id, label, event: item });
        },
      });
    } catch (failure) {
      error = String(failure?.message ?? failure);
    }
    if (engine.roleError && !engine.roleAnswer) error = engine.roleError;

    const answer = String(engine.roleAnswer ?? '').trim();
    const nextHandoff = answer ? extractHandoff(answer) : '';
    // A failed/empty role must not erase what earlier roles learned.
    if (nextHandoff) handoff = nextHandoff;
    const stage = {
      index, total, id: role.id, label, error,
      answerChars: answer.length,
      handoff: nextHandoff,
      budget: Boolean(engine.limitExhausted),
      ok: !error && Boolean(answer),
    };
    stages.push(stage);
    emit({ type: 'done', ...stage, handoffChars: handoff.length });
    if (abortCheck()) break;
  }

  return {
    task: goal,
    stages,
    stopped,
    final: handoff,
    ok: !stopped && stages.length === total && stages.every(stage => stage.ok),
  };
}

/** A short plain-text report for copying into the chat or a file. */
export function teamReport(result) {
  if (!result) return '';
  const lines = [t('agent-team.reportTitle', { p0: result.task })];
  for (const stage of result.stages) {
    lines.push('');
    lines.push(`${stage.index + 1}/${stage.total} ${stage.label}${stage.error ? ' — ' + t('agent-team.failed') + ': ' + stage.error : ''}`);
    if (stage.handoff) lines.push(stage.handoff);
    else if (!stage.error) lines.push(t('agent-team.noOutput'));
  }
  if (result.stopped) lines.push('', t('agent-team.stopped'));
  return lines.join('\n');
}
