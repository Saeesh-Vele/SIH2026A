/* ═══════════════════════════════════════════════════════════════
   Aurora — what a guided story may do, and whether it can run now.
   Loaded with the story (not at startup). App.jsx passes the live state and
   setters; stories.js steps call these through their `before(ctx)`.
   ═══════════════════════════════════════════════════════════════ */
import { apiGet, apiPost } from '../services/api';
import { stationMeta } from '../data/stationConfig';
import { demoRemainingS, mmss } from '../lib/publicDemo';
import { STORY_META } from './storyMeta';
import { noteOwnScenario } from '../assistant/bus';

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * {storyId: {ok, joins?, note?}}. Scenario stories share their station's public demo
 * slot: free → ok; the same scenario already running → ok, joining it; another one →
 * not now ("try again in 1:20"). Without the public demo (or Team sign-in) they cannot run.
 */
export function storyAvailability(stationData, canRunScenarios, now = Date.now()) {
  const sd = stationData || {};
  return Object.fromEntries(Object.entries(STORY_META).map(([id, m]) => {
    if (!m.scenario) return [id, { ok: true, note: 'Uses only your private sandbox.' }];
    if (!canRunScenarios) return [id, { ok: false, note: 'Scenario stories need the team sign-in on this server.' }];
    const r = sd.publicDemo?.[m.station];
    const left = r ? demoRemainingS(r, sd.receivedAt, now) : 0;
    if (!r || left <= 0) return [id, { ok: true }];
    if (r.scenario === m.scenario) {
      return [id, { ok: true, joins: true, note: `${r.startedBy === 'visitor' ? 'Another visitor' : 'The Aurora team'} is already running this scenario; you will follow it.` }];
    }
    return [id, { ok: false, note: `Another scenario is running at ${stationMeta(m.station).name}; try again in ${mmss(left)}, or play another story.` }];
  }));
}

/** The helpers handed to a story's steps. `live()` returns App's latest state. */
export function storyHelpers(id, { live, run, setSelectedBuilding, closeAll }) {
  const meta = STORY_META[id];
  return {
    state: () => ({ joined: Boolean(run()?.joined) }),
    data: () => live().stationData,
    waitFor: async (pred, timeout = 8000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        try { if (pred(live().stationData || {})) return true; } catch (err) { console.warn('[story] wait predicate threw', err); }
        await sleep(250);
      }
      return false;   // carry on: the step still explains what should be there
    },
    inject: async () => {
      if (!meta.scenario || run()?.joined) return;
      try {
        await apiPost(`/sim/inject/${meta.scenario}?stationId=${meta.station}`);
        noteOwnScenario(meta.station, meta.scenario);
        if (run()) run().injected = true;
      } catch (err) {
        const e = new Error('story: scenario not started');
        e.storyMessage = err?.body?.detail?.message || 'The scenario could not be started right now. Try another story.';
        throw e;
      }
    },
    reset: async () => {
      if (!run()?.injected) return;
      try {
        await apiPost(`/sim/reset?stationId=${meta.station}`);
        run().injected = false;
      } catch (err) {
        console.warn('[story] reset failed; the scenario resets itself after 2 minutes', err);
      }
    },
    setLedger: async (sid, itemId, fraction) => {
      const d = await apiGet(`/logistics?stationId=${sid}`);
      const item = (d.items || []).find((i) => i.id === itemId);
      if (!item) throw new Error(`story: no ledger item ${itemId}`);
      await apiPost('/logistics/update', {
        stationId: sid, itemId, current: Math.round(item.max * fraction), dailyConsumption: item.dailyUse, updatedBy: 'Visitor (fuel story)',
      });
      await sleep(600);
    },
    openBuilding: async (bid) => { setSelectedBuilding(bid); await sleep(350); },
    closeOverlays: () => { setSelectedBuilding(null); closeAll(); },
  };
}
