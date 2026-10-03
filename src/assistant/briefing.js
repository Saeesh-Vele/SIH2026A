/* ═══════════════════════════════════════════════════════════════
   Aurora assistant — incident briefings from the playbook + live data alone
   (no LLM): the first briefing, short updates, the next step, and the summary
   on resolution. Spoken text stays short; the card shows the full playbook.
   ═══════════════════════════════════════════════════════════════ */
import { stationMeta } from '../data/stationConfig';
import { buildingName, listText } from './actions';

const ORDINAL = ['First', 'Next', 'Then'];

export function riskSentence(risk) {
  if (!risk) return 'The decision engine has no risk assessment yet.';
  return `Risk is ${risk}.`;
}

function affectedSentence(inc) {
  const others = inc.affected.filter((b) => !inc.sources.includes(b));
  if (!others.length) return '';
  const names = others.slice(0, 3).map((b) => buildingName(inc.station, b));
  if (others.length > 3) names.push(`${others.length - 3} more`);
  return `${listText(names)} may be affected.`;
}

/** "Generator failure detected at Bharati. … First, verify backup power. …" */
export function briefingText(inc, book, { navigatedTo = null } = {}) {
  const station = stationMeta(inc.station).name;
  const parts = [`${book.title} detected at ${station}${inc.sandbox ? ', in your sandbox' : ''}.`];
  const aff = affectedSentence(inc);
  if (aff) parts.push(aff);
  parts.push(riskSentence(inc.risk));
  const todo = book.steps.map((s, i) => ({ s, i })).filter(({ i }) => !inc.done.includes(i)).slice(0, 3);
  todo.forEach(({ s }, k) => parts.push(`${ORDINAL[k]}, ${s.say}.`));
  if (navigatedTo) parts.push(`I've opened the ${navigatedTo} and highlighted the affected systems.`);
  return parts.join(' ');
}

/** A short update for an `update` / `escalate` event, or '' when there is nothing to say. */
export function updateText(ev, book) {
  const inc = ev.incident;
  const station = stationMeta(inc.station).name;
  const bits = [];
  if (ev.confirmed && !ev.risk) {
    bits.push(`The decision engine now confirms the risk at ${station} is ${inc.engineRisk}.`);
  } else if (ev.risk) {
    bits.push(ev.from ? `Risk at ${station} ${ev.type === 'escalate' ? 'escalated' : 'changed'} from ${ev.from} to ${ev.risk}.`
      : `The decision engine rates the risk ${ev.risk}.`);
  } else if (ev.type === 'escalate') {
    bits.push(`${book.title} at ${station} is now critical.`);
  }
  if (ev.added?.length) {
    const names = ev.added.map((b) => buildingName(inc.station, b));
    bits.push(`${listText(names)} ${names.length === 1 ? 'is' : 'are'} now affected.`);
  }
  return bits.join(' ');
}

export function nextStep(inc, book) {
  const i = book.steps.findIndex((_, k) => !inc.done.includes(k));
  return i < 0 ? null : { index: i, step: book.steps[i] };
}

export function nextStepText(inc, book) {
  const n = nextStep(inc, book);
  if (!n) return `Every step for the ${book.title.toLowerCase()} is ticked. Keep monitoring until it resolves.`;
  return `Step ${n.index + 1} of ${book.steps.length}: ${n.step.do}`;
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (!m) return `${r} second${r === 1 ? '' : 's'}`;
  return `${m} minute${m === 1 ? '' : 's'}${r ? ` ${r} second${r === 1 ? '' : 's'}` : ''}`;
}

export function resolvedSummary(inc, book) {
  const station = stationMeta(inc.station).name;
  const names = inc.everAffected.map((b) => buildingName(inc.station, b));
  return {
    duration: formatDuration((inc.resolvedAt || Date.now()) - inc.startedAt),
    affected: names,
    stepsDone: inc.done.length,
    stepsTotal: book.steps.length,
    text: `${book.title} at ${station} resolved after ${formatDuration((inc.resolvedAt || Date.now()) - inc.startedAt)}. `
      + (names.length ? `Affected: ${listText(names)}. ` : '')
      + `${inc.done.length} of ${book.steps.length} steps completed.`,
  };
}
