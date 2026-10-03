/* ═══════════════════════════════════════════════════════════════
   Aurora assistant — the action layer's whitelist (validation + labels).

   The ONLY actions the assistant can trigger are the ones in
   simulator/assistant_actions.json (the backend builds the LLM's tools from the
   same file and validates tool calls there too). Every action is validated again
   here before it runs: unknown names, unknown arguments and out-of-range values
   are refused. Execution lives in AssistantHost (it needs the app's setters).
   ═══════════════════════════════════════════════════════════════ */
import CATALOG from '../../simulator/assistant_actions.json';
import { STATION_IDS, buildingList, dependencyEdges, stationMeta } from '../data/stationConfig';
import { MODULES } from '../shell/navigation';

export { CATALOG };

const WHATIF_LABELS = {
  extreme_cold: 'Deep cold', blizzard: 'Blizzard', gen_failure: 'Generator trip', battery_failure: 'Battery / UPS fault',
  fuel_leak: 'Fuel leak', comms_outage: 'Satellite link loss', resupply_delay: 'Resupply delay',
};
const STORY_LABELS = { blizzard: 'Blizzard hits Maitri', generator: 'Generator failure at Bharati', fuel: 'Running low on fuel', linkloss: 'Satellite link drops at Bharati' };
const DEMO_LABELS = {
  generator_failure: 'Generator failure', heating_failure: 'Heating failure', blizzard: 'Blizzard',
  water_crisis: 'Water system alert', co2_spike: 'CO₂ spike', link_loss: 'Satellite link loss',
};
const TAB_LABELS = { active: 'active alerts', acknowledged: 'acknowledged alerts', history: 'alert history' };

export const whatIfLabel = (id) => WHATIF_LABELS[id] || id;
export const storyLabel = (id) => STORY_LABELS[id] || id;
export const demoLabel = (id) => DEMO_LABELS[id] || id;

export class InvalidAction extends Error {}

/** {type, args, stateChanging} with clean arguments, or throws InvalidAction. */
export function validateAction(action, stationId) {
  const spec = CATALOG.actions[action?.type];
  if (!spec) throw new InvalidAction(`unknown action "${action?.type}"`);
  const args = action.args && typeof action.args === 'object' && !Array.isArray(action.args) ? action.args : {};
  const extra = Object.keys(args).filter((k) => !(k in spec.args));
  if (extra.length) throw new InvalidAction(`${action.type}: unexpected ${extra.join(', ')}`);
  const buildings = new Set(buildingList(stationId).map((b) => b.id));
  const clean = {};
  for (const [key, a] of Object.entries(spec.args)) {
    let v = args[key];
    if (v == null || v === '') {
      if (a.required) throw new InvalidAction(`${action.type}: ${key} is required`);
      continue;
    }
    if (a.type === 'enum') {
      if (!CATALOG[a.of].includes(v)) throw new InvalidAction(`${action.type}: invalid ${key}`);
    } else if (a.type === 'station') {
      v = String(v).toLowerCase();
      if (!STATION_IDS.includes(v)) throw new InvalidAction(`${action.type}: unknown station`);
    } else if (a.type === 'building') {
      if (!buildings.has(v)) throw new InvalidAction(`${action.type}: unknown building`);
    } else if (a.type === 'buildingList') {
      if (!Array.isArray(v) || !v.length || !v.every((b) => buildings.has(b))) throw new InvalidAction(`${action.type}: unknown building`);
      v = [...new Set(v)];
    } else if (a.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new InvalidAction(`${action.type}: ${key} must be a number`);
      v = Math.min(a.max, Math.max(a.min, v));
    }
    clean[key] = v;
  }
  if (action.type === 'navigate' && !MODULES[clean.module]) throw new InvalidAction('navigate: unknown page');
  return { type: action.type, args: clean, stateChanging: Boolean(spec.stateChanging) };
}

export function buildingName(stationId, id) {
  return buildingList(stationId).find((b) => b.id === id)?.name || id;
}

/** Every building downstream of `id` in the dependency graph, breadth-first. */
export function downstream(stationId, id) {
  const edges = dependencyEdges(stationId);
  const out = [];
  let frontier = [id];
  while (frontier.length) {
    const next = [];
    frontier.forEach((b) => edges.forEach((e) => {
      if (e.source === b && e.target !== id && !out.includes(e.target)) { out.push(e.target); next.push(e.target); }
    }));
    frontier = next;
  }
  return out;
}

/** "a, b and c" */
export function listText(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** The chip shown in the transcript once an action has run ("Opened Energy grid"). */
export function describeAction(a, stationId) {
  const st = (sid) => stationMeta(sid || stationId).name;
  switch (a.type) {
    case 'navigate': return `Opened ${MODULES[a.args.module].label}${a.args.station ? ` for ${st(a.args.station)}` : ''}`;
    case 'switchStation': return `Switched to ${st(a.args.station)}`;
    case 'openBuildingPanel': return `Opened ${buildingName(stationId, a.args.id)}`;
    case 'highlightComponents': return `Highlighted ${listText(a.args.ids.map((b) => buildingName(stationId, b)))}`;
    case 'showDependencyChain': return `Showing what depends on ${buildingName(stationId, a.args.id)}`;
    case 'openAlertCentre': return `Opened ${TAB_LABELS[a.args.tab || 'active']}`;
    case 'runWhatIf': return `Ran what-if: ${whatIfLabel(a.args.scenario)}${a.args.intensity && a.args.intensity !== 1 ? ` ×${a.args.intensity}` : ''}`;
    case 'startStory': return `Started story: ${storyLabel(a.args.id)}`;
    case 'triggerDemoScenario': return `Started demo: ${demoLabel(a.args.id)} at ${st(a.args.station)}`;
    case 'openAiDiagnostics': return `Opened AI diagnostics${a.args.station ? ` for ${st(a.args.station)}` : ''}`;
    case 'stopSpeaking': return 'Stopped speaking';
    case 'mute': return 'Voice off';
    default: return a.type;
  }
}

/** A short label for a suggestion button ("Open AI diagnostics"). */
export function suggestLabel(a, stationId) {
  return describeAction(a, stationId)
    .replace(/^Opened /, 'Open ').replace(/^Switched to /, 'Switch to ').replace(/^Highlighted /, 'Highlight ')
    .replace(/^Showing what depends on /, 'Show what depends on ').replace(/^Ran what-if: /, 'Run what-if: ');
}
