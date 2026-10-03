/* ═══════════════════════════════════════════════════════════════
   Aurora assistant — the deterministic local intent parser (no LLM, no network).

   Handles the common commands: open/show a page, switch station, show alerts,
   highlight a building or what depends on it, run a named what-if, start a story,
   run a demo scenario, mute/stop, yes/no for a pending confirmation, and the
   incident controls ("what should I do next?", "done", "snooze", "dismiss").
   Anything else is a question for the backend (POST /api/assistant/chat).

   Vocabulary comes from simulator/assistant_actions.json (shared with the backend's
   parser) and station names from station_config.json.

   parseIntent(text, {station, module, incident, pending}) →
     {kind: 'actions', actions}         run these (validated again before running)
     {kind: 'control', control}         stop | mute | unmute | confirm | cancel |
                                        next-step | tick | snooze | dismiss | repeat
     {kind: 'question', text}           ask the backend
   ═══════════════════════════════════════════════════════════════ */
import { STATION_IDS, stationMeta } from '../data/stationConfig';
import { CATALOG } from './actions';

export function normalise(text) {
  return String(text || '').toLowerCase().replace(/[’`]/g, "'").replace(/co₂/g, 'co2')
    .replace(/[?!.,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseRe = (p) => new RegExp(`(?<![a-z0-9])${esc(p)}(?![a-z0-9])`);

/** Ids of a vocabulary kind mentioned in `t`, first mention first; longer phrases win. */
export function matchVocab(t, kind) {
  const vocab = CATALOG.vocabulary[kind];
  const pairs = Object.entries(vocab).filter(([id]) => !id.startsWith('_'))
    .flatMap(([id, phrases]) => phrases.map((p) => [p, id]))
    .sort((a, b) => b[0].length - a[0].length);
  const taken = [];
  const hits = [];
  for (const [p, id] of pairs) {
    const re = new RegExp(phraseRe(p).source, 'g');
    let m;
    while ((m = re.exec(t))) {
      const s = m.index; const e = s + m[0].length;
      if (!taken.some(([a, b]) => s < b && a < e)) { taken.push([s, e]); hits.push([s, id]); }
    }
  }
  return [...new Set(hits.sort((a, b) => a[0] - b[0]).map((h) => h[1]))];
}

export function matchStation(t) {
  return STATION_IDS.find((sid) => phraseRe(stationMeta(sid).name.toLowerCase()).test(t) || phraseRe(sid).test(t)) || null;
}

const CONTROL = [
  ['stop', /^(?:aurora )?(?:stop|stop talking|quiet|be quiet|shush|silence|enough)$/],
  ['mute', /^(?:aurora )?(?:mute|mute yourself|voice off|turn (?:your |the )?voice off|stop speaking(?: for now)?|don't speak)$/],
  ['unmute', /^(?:aurora )?(?:unmute|voice on|turn (?:your |the )?voice (?:back )?on|speak again)$/],
  ['confirm', /^(?:yes|yeah|yep|yes please|confirm|confirmed|go ahead|do it|ok|okay|proceed|affirmative|sure)$/],
  ['cancel', /^(?:no|nope|cancel|don't|do not|abort|negative|never mind|nevermind)$/],
  ['next-step', /^(?:(?:so |ok |okay )?what (?:should|do|must|can) (?:i|we) do(?: next| now)?|what(?:'s| is) (?:the )?next(?: step)?|next step|what now)$/],
  ['tick', /^(?:done|step done|that's done|completed?|tick(?: it)?|mark (?:it|that|the step) (?:as )?done|check(?:ed)?)$/],
  ['snooze', /^(?:snooze|snooze (?:it|the incident|this)|remind me later|later)$/],
  ['dismiss', /^(?:dismiss|dismiss (?:it|the incident|this)|close (?:the )?incident)$/],
  ['repeat', /^(?:repeat|say (?:that|it) again|repeat (?:that|the briefing)|brief me|briefing)$/],
];

const VERB = /\b(?:open|show|go to|goto|take me to|switch to|navigate to|bring up|pull up|display|jump to|view|see)\b/;
const WHATIF = /\bwhat (?:happens|would happen|will happen|if)\b|\bwhat-if\b|\bwhatif\b|\bsimulate\b|\bsuppose\b|\bimagine\b|\bhypothetical/;
const DEMO_VERB = /\b(?:trigger|inject|start|run|launch|cause)\b/;
const DEMO_NOUN = /\b(?:scenario|demo|fault|failure|spike|loss|crisis|outage)\b/;

function intensityOf(t) {
  if (/\b(?:twice|double|extreme|severe|massive|huge|very strong)\b/.test(t)) return 2;
  if (/\b(?:strong|heavy|bad|big)\b/.test(t)) return 1.5;
  if (/\b(?:mild|light|small|minor|slight)\b/.test(t)) return 0.5;
  return 1;
}

/**
 * @param {string} text
 * @param {{station: string, module?: string, incident?: boolean, pending?: boolean}} ctx
 */
export function parseIntent(text, ctx) {
  const t = normalise(text);
  if (!t) return { kind: 'none' };
  for (const [control, re] of CONTROL) {
    if (!re.test(t)) continue;
    if ((control === 'confirm' || control === 'cancel') && !ctx.pending) break;
    if (['next-step', 'tick', 'snooze', 'dismiss', 'repeat'].includes(control) && !ctx.incident) break;
    return { kind: 'control', control };
  }

  const station = matchStation(t);
  const at = station && station !== ctx.station ? station : null;
  const modules = matchVocab(t, 'modules');
  const buildings = matchVocab(t, 'buildings');
  const actions = [];

  // Stories: "start the blizzard story", "play the generator story".
  if (/\bstor(?:y|ies)\b/.test(t)) {
    const story = matchVocab(t, 'stories')[0];
    if (story) return { kind: 'actions', actions: [{ type: 'startStory', args: { id: story } }] };
  }

  // What-if: "what happens if there's a blizzard at Maitri?" (read-only, rule-based).
  if (WHATIF.test(t)) {
    const scenario = matchVocab(t, 'whatIfScenarios')[0];
    if (scenario) {
      if (at) actions.push({ type: 'switchStation', args: { station: at } });
      actions.push({ type: 'runWhatIf', args: { scenario, intensity: intensityOf(t) } });
      return { kind: 'actions', actions };
    }
  }

  // Demo scenarios (shared, state-changing: confirmed before running).
  if (DEMO_VERB.test(t) && DEMO_NOUN.test(t) && !/\bwhat\b|\bwhy\b/.test(t)) {
    const id = matchVocab(t, 'demoScenarios')[0];
    if (id) return { kind: 'actions', actions: [{ type: 'triggerDemoScenario', args: { id, station: station || ctx.station } }] };
  }

  // "Show me what depends on the generator"
  if (/\bdepend|\bdownstream\b|\b(?:relies|rely|runs) on\b/.test(t) && buildings.length) {
    if (at) actions.push({ type: 'switchStation', args: { station: at } });
    actions.push({ type: 'showDependencyChain', args: { id: buildings[0] } });
    return { kind: 'actions', actions, answer: 'depends' };
  }

  // Alert centre.
  if (/\b(?:alert|alarm)s?\b/.test(t) && (VERB.test(t) || /^(?:alerts?|alarms?)(?: centre| center)?$/.test(t))) {
    const tab = /\bhistory\b|\bpast\b/.test(t) ? 'history' : /\backnowledged\b/.test(t) ? 'acknowledged' : 'active';
    if (at) actions.push({ type: 'switchStation', args: { station: at } });
    actions.push({ type: 'openAlertCentre', args: { tab } });
    return { kind: 'actions', actions };
  }

  // Highlight: "highlight the water plant", "where is the comms tower?"
  if (/\bhighlight\b|\bpoint out\b|\bwhere (?:is|are)\b|\bmark\b/.test(t) && buildings.length) {
    if (at) actions.push({ type: 'switchStation', args: { station: at } });
    actions.push({ type: 'highlightComponents', args: { ids: buildings } });
    return { kind: 'actions', actions };
  }

  const bare = t.split(' ').length <= 3 && !/\b(?:what|why|how|when|who|which|is|are|does|do|can)\b/.test(t);
  if (VERB.test(t) || bare) {
    // AI diagnostics has its own action (it can carry a station).
    if (modules[0] === 'ai') return { kind: 'actions', actions: [{ type: 'openAiDiagnostics', args: station ? { station } : {} }] };
    if (modules.length) {
      return { kind: 'actions', actions: [{ type: 'navigate', args: { module: modules[0], ...(at ? { station: at } : {}) } }] };
    }
    if (buildings.length && VERB.test(t)) {
      if (at) actions.push({ type: 'switchStation', args: { station: at } });
      actions.push({ type: 'openBuildingPanel', args: { id: buildings[0] } });
      return { kind: 'actions', actions };
    }
    if (station && (VERB.test(t) || /^(?:switch|change)\b/.test(t) || t === station || t === stationMeta(station).name.toLowerCase())) {
      return { kind: 'actions', actions: at ? [{ type: 'switchStation', args: { station } }] : [], already: !at };
    }
  }
  if (station && /^(?:switch|change)(?: station)?(?: to)?\b/.test(t)) {
    return { kind: 'actions', actions: at ? [{ type: 'switchStation', args: { station } }] : [], already: !at };
  }
  return { kind: 'question', text: String(text).trim() };
}
