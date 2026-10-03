/* ═══════════════════════════════════════════════════════════════
   Aurora assistant — the tiny shared store loaded at startup.

   Everything else of the assistant is a lazy chunk (AssistantHost and below).
   This holds only what startup code and the pages need to see:
     open       the assistant panel is showing
     ptt        push-to-talk is held (hold "V", or the mic button)
     highlight  components the assistant highlighted: {ids, chainFrom, label}
                (Infrastructure tiles, the dependency map and the highlight strip)
     gesture    the user has interacted with the page: until then Aurora never
                speaks or navigates on its own (incidents still show visually)
     own        demo scenarios THIS browser started ({station, scenario, at}): Aurora
                opens pages and speaks on its own only for the visitor's own incidents
   ═══════════════════════════════════════════════════════════════ */
import { useSyncExternalStore } from 'react';

let state = { open: false, opened: false, ptt: false, highlight: null, gesture: false, draft: null, ask: null, own: [] };
const listeners = new Set();

export function getAssistant() { return state; }

export function setAssistant(patch) {
  const next = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  if (next.open) next.opened = true;      // the panel chunk stays mounted once loaded
  if (Object.keys(next).every((k) => next[k] === state[k])) return;
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(l) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** useAssistant((s) => s.open) — re-renders only when the selected value changes. */
export function useAssistant(select) {
  return useSyncExternalStore(subscribe, () => select(state), () => select(state));
}

/** Open the panel; `draft` prefills the text box. */
export function openAssistant(draft = null) { setAssistant({ open: true, draft }); }

/** Open the panel and send `text` as a request (the command palette's "Ask Aurora: …"). */
export function askAurora(text) { setAssistant({ open: true, ask: { text, at: Date.now() } }); }

/** Record a demo scenario this visitor started (Demo Control, a story, or Aurora). */
export function noteOwnScenario(station, scenario) {
  setAssistant((s) => ({ own: [...s.own.slice(-9), { station, scenario, at: Date.now() }] }));
}

if (typeof window !== 'undefined') {
  const mark = () => setAssistant({ gesture: true });
  window.addEventListener('pointerdown', mark, { once: true, capture: true });
  window.addEventListener('keydown', mark, { once: true, capture: true });
}
