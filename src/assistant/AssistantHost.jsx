/* ═══════════════════════════════════════════════════════════════
   Aurora assistant — the host (lazy chunk, mounted after the first snapshot).

   Owns the conversation, the action layer's execution, speech and incident mode;
   renders the panel (AssistantPanel, its own chunk) when open, a compact incident
   card when it is closed, and the "highlighted by Aurora" strip on the page.

   Rules it enforces:
   - Only validated, whitelisted actions run (actions.js). State-changing ones ask
     first (useConfirm; "yes" / "no" by voice works too) and go through the normal
     routes, so the public-demo rules and ADMIN_TOKEN apply exactly as for a click.
   - Never speaks or navigates before the user has interacted with the page, and
     never while a tour or story runs; incidents still show visually.
   - Spoken incident updates: at most one per 20 s unless the risk escalates.
   ═══════════════════════════════════════════════════════════════ */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiGet, apiPost } from '../services/api';
import { usePolling } from '../hooks/usePolling';
import { useNow } from '../hooks/useNow';
import { stationMeta } from '../data/stationConfig';
import { MODULES } from '../shell/navigation';
import { STORY_META } from '../tour/storyMeta';
import { useConfirm } from '../ui/feedbackContext';
import { describeFailure } from '../lib/failure';
import { getAssistant, noteOwnScenario, setAssistant, useAssistant } from './bus';
import { buildingName, demoLabel, describeAction, downstream, InvalidAction, listText, storyLabel, validateAction, whatIfLabel } from './actions';
import { parseIntent } from './intents';
import { emptyState, observationFrom, observe, queue } from './incidents';
import { briefingText, nextStep, nextStepText, resolvedSummary, updateText } from './briefing';
import { createRecognizer, recognitionErrorText, speak, speechSupport, stopSpeaking } from './speech';
import { loadPrefs, savePrefs } from './prefs';
import IncidentCard from './IncidentCard';
import HighlightStrip from './HighlightStrip';

const AssistantPanel = lazy(() => import('./AssistantPanel'));

const CONTEXT_POLL_MS = 10000;
const SPOKEN_UPDATE_GAP_MS = 20000;
const SNOOZE_MS = 5 * 60 * 1000;
let nextId = 1;
const uid = () => `e${nextId++}`;

function refusal(err) {
  const msg = err?.body?.detail?.message || (typeof err?.body?.detail === 'string' ? err.body.detail : null);
  if (msg) return msg;
  if (err?.status === 401) return 'this server needs the team sign-in for that';
  if (err?.status === 429) return 'too many requests; try again in a minute';
  if (err?.status === 503) return 'the simulator is offline';
  return describeFailure(err);
}

function whatIfSpoken(r, station) {
  const lines = (r.consequences || []).filter((c) => !/not recomputed/.test(c)).slice(0, 2).join(' ');
  const risk = r.calculatedRisk;
  return `Rule-based what-if for ${whatIfLabel(r.scenarioId).toLowerCase()} at ${stationMeta(station).name}; nothing in the twin changes. ${lines}`
    + (risk ? ` Rule-based risk ${risk.score} of 100, ${risk.level}.` : '');
}

export default function AssistantHost({ stationData, activeStation, activeModule, controls, canRunScenarios, tourActive, isPhone, writeProtected }) {
  const open = useAssistant((s) => s.open);
  const ptt = useAssistant((s) => s.ptt);
  const gesture = useAssistant((s) => s.gesture);
  const highlight = useAssistant((s) => s.highlight);
  const panelMounted = useAssistant((s) => s.opened);
  const confirm = useConfirm();
  const support = useMemo(() => speechSupport(), []);
  const now = useNow(5000);
  const [prefs, setPrefsState] = useState(loadPrefs);
  const [entries, setEntries] = useState([]);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [pending, setPending] = useState(null);
  const [books, setBooks] = useState(null);
  const [ctx, setCtx] = useState(null);
  const [status, setStatus] = useState(null);
  const [inc, setInc] = useState(emptyState);
  const [focusKey, setFocusKey] = useState(null);
  const [snoozed, setSnoozed] = useState({});
  const [micError, setMicError] = useState(null);

  // Async flows read the latest values through this ref (they outlive renders).
  const live = useRef({});
  useEffect(() => {
    live.current = { prefs, activeStation, activeModule, ctx, books, inc, gesture, tourActive, open, snoozed, stationData, pending };
  });

  const setPrefs = useCallback((patch) => setPrefsState((p) => { const n = { ...p, ...patch }; savePrefs(n); return n; }), []);
  const add = useCallback((e) => {
    const entry = { id: uid(), at: Date.now(), ...e };
    setEntries((list) => [...list.slice(-80), entry]);
    return entry.id;
  }, []);
  const patchEntry = useCallback((id, patch) => setEntries((list) => list.map((e) => (e.id === id ? { ...e, ...(typeof patch === 'function' ? patch(e) : patch) } : e))), []);

  // ── Data: playbooks once, the station context every 10 s, the LLM status on open ──
  useEffect(() => {
    let alive = true;
    apiGet('/assistant/playbooks').then((d) => { if (alive) setBooks(d); })
      .catch((err) => console.warn('[Aurora] playbooks unavailable; incident mode needs them', err));
    return () => { alive = false; };
  }, []);
  const refreshCtx = useCallback(async (station = live.current.activeStation) => {
    const d = await apiGet(`/assistant/context?stationId=${station}`, { timeoutMs: 8000 });
    if (live.current.activeStation === station) setCtx(d);
    return d;
  }, []);
  usePolling(async (isActive) => {
    const d = await apiGet(`/assistant/context?stationId=${activeStation}`, { timeoutMs: 8000 });
    if (isActive()) setCtx(d);
  }, CONTEXT_POLL_MS, { key: activeStation });
  useEffect(() => {
    if (!open) return;
    apiGet('/assistant/status').then(setStatus).catch((err) => {
      console.warn('[Aurora] status unavailable', err);
      setStatus({ llmAvailable: false, notice: 'Answering from station data only' });
    });
  }, [open]);

  // ── Speech out ──
  const recRef = useRef(null);
  const canSpeak = useCallback((force = false) => {
    const l = live.current;
    return support.synthesis && l.prefs.voice && l.gesture && (!l.tourActive || force);
  }, [support.synthesis]);
  const say = useCallback(async (text, { force = false } = {}) => {
    if (!text || !canSpeak(force)) return;
    const l = live.current;
    const resume = Boolean(recRef.current?.conversation);
    if (resume) { try { recRef.current.rec.abort(); } catch (err) { console.warn('[Aurora] pause listening', err); } }
    setSpeaking(true);
    await speak(text, { rate: l.prefs.rate, lang: l.prefs.lang });
    setSpeaking(false);
  }, [canSpeak]);
  const hush = useCallback(() => { stopSpeaking(); setSpeaking(false); }, []);

  // ── Confirmation (click or voice) ──
  const askConfirm = useCallback(async (a) => {
    const name = stationMeta(a.args.station || live.current.activeStation).name;
    const minutes = 2;
    let title;
    let body;
    if (a.type === 'triggerDemoScenario') {
      title = `Run “${demoLabel(a.args.id)}” at ${name}?`;
      body = `Every visitor sees it: a simulated fault for about ${minutes} minutes, then the station resets itself. The values are labelled Simulated. Nothing real is affected.`;
    } else {
      const meta = STORY_META[a.args.id];
      title = `Start the story “${storyLabel(a.args.id)}”?`;
      body = meta?.scenario
        ? `It runs a shared demo scenario at ${stationMeta(meta.station).name} that every visitor sees, then resets it. Nothing real is affected.`
        : 'It changes values in your private sandbox only.';
    }
    const id = add({ role: 'aurora', text: `${title} Say “yes” to confirm or “no” to cancel.`, kind: 'confirm' });
    say(`${title} Say yes to confirm, or no to cancel.`);
    const ok = await confirm({ title, body, confirmLabel: a.type === 'startStory' ? 'Start story' : 'Run scenario', bind: (settle) => setPending({ settle }) });
    setPending(null);
    patchEntry(id, { resolved: ok ? 'Confirmed' : 'Cancelled' });
    return ok;
  }, [add, confirm, patchEntry, say]);

  // ── The action layer: execute one validated action → {chip, undo?, say?} ──
  const execute = useCallback(async (a) => {
    const l = live.current;
    const before = controls.get();
    const restorePage = () => { controls.setStation(before.station); controls.navigate(before.module); };
    const prevHighlight = getAssistant().highlight;
    const restoreHighlight = () => setAssistant({ highlight: prevHighlight });
    switch (a.type) {
      case 'navigate': {
        if (a.args.station) controls.setStation(a.args.station);
        controls.navigate(a.args.module);
        return { undo: restorePage };
      }
      case 'switchStation':
        controls.setStation(a.args.station);
        return { undo: () => controls.setStation(before.station) };
      case 'openBuildingPanel':
        controls.openBuilding(a.args.id);
        return { undo: () => controls.openBuilding(before.building) };
      case 'highlightComponents':
        setAssistant({ highlight: { ids: a.args.ids, station: l.activeStation, chainFrom: null } });
        return { undo: restoreHighlight };
      case 'showDependencyChain': {
        const deps = downstream(l.activeStation, a.args.id);
        setAssistant({ highlight: { ids: [a.args.id, ...deps], station: l.activeStation, chainFrom: a.args.id } });
        if (l.prefs.autoNavigate && before.module !== 'infrastructure') controls.navigate('infrastructure');
        controls.scrollTo('infra-dependency');
        const names = deps.map((d) => buildingName(l.activeStation, d));
        return {
          undo: () => { restoreHighlight(); if (before.module !== 'infrastructure') restorePage(); },
          say: names.length ? `${names.length} systems depend on the ${buildingName(l.activeStation, a.args.id)}: ${listText(names)}.`
            : `Nothing in the dependency graph depends on the ${buildingName(l.activeStation, a.args.id)}.`,
        };
      }
      case 'openAlertCentre':
        controls.openAlerts(a.args.tab || 'active');
        return { undo: controls.closeOverlay };
      case 'openAiDiagnostics':
        if (a.args.station) controls.setStation(a.args.station);
        controls.navigate('ai');
        return { undo: restorePage };
      case 'runWhatIf': {
        const station = l.activeStation;
        const intensity = a.args.intensity ?? 1;
        const r = await apiPost('/simulation/whatif', { stationId: station, scenarioId: a.args.scenario, intensity }, { timeoutMs: 15000 });
        controls.whatIf({ scenario: a.args.scenario, intensity, result: r, station, nonce: Date.now() });
        if (l.prefs.autoNavigate) controls.navigate('simulation');
        return {
          undo: l.prefs.autoNavigate ? restorePage : null,
          say: whatIfSpoken(r, station),
          detail: [...(r.consequences || []), `Assumptions: ${(r.assumptions || []).join('; ')}.`,
            r.calculatedRisk ? `Recommended: ${r.calculatedRisk.recommendedAction}` : null, 'Read-only: computed against the current snapshot; nothing in the twin changed.'].filter(Boolean),
        };
      }
      case 'startStory':
        setAssistant({ open: false });
        controls.startStory(a.args.id);
        return {};
      case 'triggerDemoScenario': {
        const station = a.args.station || l.activeStation;
        if (!canRunScenarios) throw Object.assign(new Error('not allowed'), { userMessage: 'Demo scenarios need the team sign-in on this server.' });
        await apiPost(`/sim/inject/${a.args.id}?stationId=${station}`);
        noteOwnScenario(station, a.args.id);
        if (station !== l.activeStation) controls.setStation(station);
        return { say: `Started the ${demoLabel(a.args.id).toLowerCase()} demo at ${stationMeta(station).name}. It is simulated and resets itself in about 2 minutes.` };
      }
      case 'stopSpeaking':
        hush();
        return {};
      case 'mute':
        hush();
        setPrefs({ voice: false });
        return {};
      default:
        throw new InvalidAction(`no executor for ${a.type}`);
    }
  }, [controls, canRunScenarios, hush, setPrefs]);

  /** Validate, confirm if needed, run; returns {chips, said, detail}. */
  const runActions = useCallback(async (actions) => {
    const chips = [];
    const said = [];
    const detail = [];
    for (const raw of actions) {
      let a;
      try {
        a = validateAction(raw, live.current.activeStation);
      } catch (err) {
        console.warn('[Aurora] refused action', raw, err);
        chips.push({ id: uid(), label: `Refused: ${raw?.type || 'unknown action'}`, refused: true });
        continue;
      }
      if (a.stateChanging && !(await askConfirm(a))) {
        chips.push({ id: uid(), label: `Cancelled: ${describeAction(a, live.current.activeStation)}`, refused: true });
        said.push('Cancelled.');
        continue;
      }
      const label = describeAction(a, live.current.activeStation);
      try {
        const r = await execute(a);
        chips.push({ id: uid(), label, undo: r.undo || null, action: a.type });
        if (r.say) said.push(r.say);
        if (r.detail) detail.push(...r.detail);
      } catch (err) {
        console.warn('[Aurora] action failed', a, err);
        const why = err?.userMessage || refusal(err);
        chips.push({ id: uid(), label: `Not done: ${label.replace(/^(Started|Ran|Opened) /, '')}`, refused: true });
        said.push(`That didn't work: ${why}.`);
      }
    }
    return { chips, said, detail };
  }, [askConfirm, execute]);

  const undo = useCallback((entryId, chipId) => {
    // Run the undo here, never inside a state updater: it changes the app's own state.
    const chip = live.current.entries?.find((e) => e.id === entryId)?.chips?.find((c) => c.id === chipId);
    if (!chip?.undo || chip.undone) return;
    try { chip.undo(); } catch (err) { console.warn('[Aurora] undo failed', err); }
    setEntries((list) => list.map((e) => (e.id !== entryId ? e
      : { ...e, chips: e.chips.map((c) => (c.id === chipId ? { ...c, undone: true } : c)) })));
  }, []);

  // ── Incidents ──
  const lastSpoken = useRef({});
  const pendingUpdate = useRef({});
  const incidentNav = useRef({});
  const currentIncident = useMemo(() => {
    const q = queue(inc);
    return q.find((i) => i.key === focusKey) || q[0] || null;
  }, [inc, focusKey]);
  const shownIncident = currentIncident
    || Object.values(inc.incidents).filter((i) => i.status === 'resolved' && !i.dismissed && i.key === focusKey)[0] || null;
  const bookOf = useCallback((i) => (books?.playbooks || []).find((b) => b.id === i?.playbookId), [books]);

  const speakIncident = useCallback((key, text, { urgent = false } = {}) => {
    const l = live.current;
    if (!text || (l.snoozed[key] || 0) > Date.now()) return;
    const now = Date.now();
    const since = now - (lastSpoken.current[key] || 0);
    if (urgent || since >= SPOKEN_UPDATE_GAP_MS) {
      lastSpoken.current[key] = now;
      clearTimeout(pendingUpdate.current[key]?.timer);
      delete pendingUpdate.current[key];
      say(text);
      return;
    }
    // Debounce: keep only the latest update and say it when the 20 s window opens.
    clearTimeout(pendingUpdate.current[key]?.timer);
    pendingUpdate.current[key] = {
      text,
      timer: setTimeout(() => {
        const p = pendingUpdate.current[key];
        delete pendingUpdate.current[key];
        const cur = live.current.inc.incidents[key];
        if (p && cur?.status === 'active' && !cur.dismissed) { lastSpoken.current[key] = Date.now(); say(p.text); }
      }, SPOKEN_UPDATE_GAP_MS - since),
    };
  }, [say]);

  const autoNavigate = useCallback((incident, book) => {
    const before = controls.get();
    const prevHighlight = getAssistant().highlight;
    const focus = book.focus;
    const chain = focus ? [focus, ...downstream(incident.station, focus)] : [];
    const ids = [...new Set([...incident.affected, ...chain])];
    if (incident.station !== before.station) controls.setStation(incident.station);
    if (MODULES[book.page]) controls.navigate(book.page);
    setAssistant({ highlight: { ids, station: incident.station, chainFrom: focus, incident: incident.key } });
    incidentNav.current[incident.key] = true;
    return {
      label: `Opened ${MODULES[book.page]?.label || book.page} and highlighted the affected systems`,
      undo: () => { setAssistant({ highlight: prevHighlight }); controls.setStation(before.station); controls.navigate(before.module); },
    };
  }, [controls]);

  /** The visitor's own incident: a demo scenario this browser started (≤ 10 min ago) or
   *  their own sandbox alerts. Everything else is someone else's or shared. */
  const isOwn = useCallback((i) => {
    if (i.sandbox) return true;
    const book = bookOf(i);
    return getAssistant().own.some((o) => o.station === i.station && Date.now() - o.at < 10 * 60 * 1000
      && (o.scenario === i.scenario || (book && book.match.scenarios.includes(o.scenario))));
  }, [bookOf]);

  const handleIncidentEvents = useCallback(async (events) => {
    for (const ev of events) {
      const i = ev.incident;
      const book = bookOf(i);
      if (!book) continue;
      const l = live.current;
      if (ev.type === 'new') {
        // Ask the decision engine for its view now (it can lag the alerts), then re-read it.
        // Until it catches up the incident states the playbook's baseline risk (incidents.js).
        apiPost(`/assistant/evaluate?stationId=${i.station}`, undefined, { timeoutMs: 5000 })
          .catch((err) => console.warn('[Aurora] decision re-evaluation request failed', err));
        [2500, 6000].forEach((ms) => setTimeout(() => { refreshCtx(i.station).catch((err) => console.warn('[Aurora] context refresh failed', err)); }, ms));
        const live0 = !i.atLoad && l.gesture && !l.tourActive && (l.snoozed[i.key] || 0) < Date.now();
        // Only the visitor's own incidents (their demo scenario, their sandbox) open the panel,
        // navigate and speak by themselves; others show the floating card with "Show me".
        const own = isOwn(i);
        const takeOver = live0 && own;
        const speakIt = live0 && (own || l.prefs.announceAll);
        let chips = [];
        let navigatedTo = null;
        if (takeOver) {
          setFocusKey((k) => k || i.key);
          setAssistant({ open: true });
          if (l.prefs.autoNavigate) {
            const nav = autoNavigate(i, book);
            chips = [{ id: uid(), label: nav.label, undo: nav.undo }];
            navigatedTo = MODULES[book.page]?.label || null;
          }
        }
        const text = briefingText(i, book, { navigatedTo });
        add({ role: 'aurora', kind: 'incident', incidentKey: i.key, text, chips, quiet: !takeOver,
          note: own ? null : 'Started by someone else or from shared data: shown, not opened for you.' });
        if (speakIt) { lastSpoken.current[i.key] = Date.now(); say(text); }
      } else if (ev.type === 'update' || ev.type === 'escalate') {
        if (i.dismissed) continue;
        const text = updateText(ev, book);
        if (!text) continue;
        add({ role: 'aurora', kind: 'update', incidentKey: i.key, text });
        if (l.gesture && !l.tourActive && (isOwn(i) || l.prefs.announceAll)) speakIncident(i.key, text, { urgent: ev.type === 'escalate' });
        if (incidentNav.current[i.key] && ev.added?.length) {
          setAssistant((s) => (s.highlight?.incident === i.key ? { highlight: { ...s.highlight, ids: [...new Set([...s.highlight.ids, ...ev.added])] } } : {}));
        }
      } else if (ev.type === 'resolved') {
        clearTimeout(pendingUpdate.current[i.key]?.timer);
        delete pendingUpdate.current[i.key];
        const sum = resolvedSummary(i, book);
        add({ role: 'aurora', kind: 'summary', incidentKey: i.key, text: sum.text, summary: sum });
        if (!i.dismissed && l.gesture && !l.tourActive && (isOwn(i) || l.prefs.announceAll)) say(sum.text);
        if (getAssistant().highlight?.incident === i.key) setAssistant({ highlight: null });
        setFocusKey((k) => k || i.key);
      }
    }
  }, [add, autoNavigate, bookOf, isOwn, refreshCtx, say, speakIncident]);

  // Observe the active station on every snapshot (and every context poll).
  const obsKey = JSON.stringify([activeStation, (stationData.activeAlerts || []).map((a) => [a.id, a.level]),
    stationData.publicDemo?.[activeStation]?.scenario, stationData.provenance?.activeScenario, stationData.link?.up,
    (stationData.dependencyAlerts || []).map((d) => (d.chain || []).join('>')), ctx?.station?.id, ctx?.anomaly?.isAnomaly,
    ctx?.anomaly?.maxResidualSigma, ctx?.decision?.risk?.level]);
  useEffect(() => {
    if (!books?.playbooks) return;
    const sd = live.current.stationData;
    const obs = observationFrom(activeStation, sd, live.current.ctx);
    const r = observe(live.current.inc, obs, books.playbooks, Date.now());
    live.current.inc = r.state;
    setInc(r.state);
    if (r.events.length) handleIncidentEvents(r.events);
  }, [obsKey, now, books, activeStation, handleIncidentEvents]);     // `now`: a 5 s heartbeat so a cleared trigger resolves

  const patchIncident = useCallback((key, fn) => setInc((s) => (s.incidents[key] ? { ...s, incidents: { ...s.incidents, [key]: fn(s.incidents[key]) } } : s)), []);
  const toggleStep = useCallback((key, index) => patchIncident(key, (i) => ({ ...i, done: i.done.includes(index) ? i.done.filter((d) => d !== index) : [...i.done, index] })), [patchIncident]);
  const incidentControl = useCallback((control, key = live.current.focusKey || queue(live.current.inc)[0]?.key) => {
    const i = live.current.inc.incidents[key];
    const book = bookOf(i);
    if (!i || !book) return null;
    if (control === 'next-step') return nextStepText(i, book);
    if (control === 'tick') {
      const n = nextStep(i, book);
      if (!n) return 'Every step is already ticked.';
      toggleStep(key, n.index);
      const after = book.steps.findIndex((_, k) => k !== n.index && !i.done.includes(k));
      return `Ticked step ${n.index + 1}.${after >= 0 ? ` Next: ${book.steps[after].say}.` : ' That was the last step.'}`;
    }
    if (control === 'snooze') {
      setSnoozed((s) => ({ ...s, [key]: Date.now() + SNOOZE_MS }));
      clearTimeout(pendingUpdate.current[key]?.timer);
      return `Snoozed the ${book.title.toLowerCase()} for 5 minutes. The card stays in the panel.`;
    }
    if (control === 'dismiss') {
      patchIncident(key, (x) => ({ ...x, dismissed: true }));
      setFocusKey(null);
      if (getAssistant().highlight?.incident === key) setAssistant({ highlight: null });
      return `Dismissed the ${book.title.toLowerCase()}. I'll stop updating it.`;
    }
    if (control === 'repeat') return briefingText(i, book);
    return null;
  }, [bookOf, patchIncident, toggleStep]);
  useEffect(() => { live.current.focusKey = currentIncident?.key; });

  // ── One request, typed or spoken ──
  const handle = useCallback(async (text, via = 'text') => {
    const t = String(text || '').trim();
    if (!t) return;
    const l = live.current;
    add({ role: 'user', text: t, via });
    const parsed = parseIntent(t, { station: l.activeStation, module: l.activeModule, incident: Boolean(queue(l.inc).length), pending: Boolean(l.pending) });

    if (parsed.kind === 'control') {
      const c = parsed.control;
      if (c === 'confirm' || c === 'cancel') { l.pending?.settle(c === 'confirm'); return; }
      if (c === 'stop') { hush(); add({ role: 'aurora', text: 'Stopped.', chips: [{ id: uid(), label: 'Stopped speaking' }] }); return; }
      if (c === 'mute') { hush(); setPrefs({ voice: false }); add({ role: 'aurora', text: 'Voice off. I’ll answer in text; say or type “unmute” to hear me again.', chips: [{ id: uid(), label: 'Voice off', undo: () => setPrefs({ voice: true }) }] }); return; }
      if (c === 'unmute') { setPrefs({ voice: true }); add({ role: 'aurora', text: 'Voice on.' }); live.current.prefs = { ...l.prefs, voice: true }; say('Voice on.'); return; }
      const reply = incidentControl(c);
      if (reply) { add({ role: 'aurora', text: reply }); say(reply); }
      return;
    }

    if (parsed.kind === 'actions') {
      if (!parsed.actions.length) {
        const msg = parsed.already ? `You're already viewing ${stationMeta(l.activeStation).name}.` : 'Nothing to do.';
        add({ role: 'aurora', text: msg });
        say(msg);
        return;
      }
      setBusy(true);
      const r = await runActions(parsed.actions);
      setBusy(false);
      const spoken = r.said.length ? r.said.join(' ') : `${r.chips.filter((c) => !c.refused).map((c) => c.label).join('. ')}.`;
      add({ role: 'aurora', text: spoken, chips: r.chips, detail: r.detail, mode: 'local' });
      say(spoken);
      return;
    }

    // A question (or anything the local parser does not know): ask the backend.
    setBusy(true);
    const history = live.current.entries?.slice?.(-4) || [];
    try {
      const out = await apiPost('/assistant/chat', {
        stationId: l.activeStation, text: t.slice(0, 500), page: l.activeModule, lang: l.prefs.lang,
        history: history.filter((e) => e.role === 'user' || e.role === 'aurora').map((e) => ({ role: e.role === 'user' ? 'user' : 'assistant', text: String(e.text).slice(0, 600) })),
      }, { timeoutMs: 30000 });
      const isCommand = out.topic === 'unknown' && out.actions?.length;
      const auto = isCommand ? out.actions : out.actions.filter((a) => a.type === 'highlightComponents' && out.station === live.current.activeStation);
      const suggest = isCommand ? [] : out.actions.filter((a) => !auto.includes(a));
      if (out.station !== live.current.activeStation) suggest.unshift({ type: 'switchStation', args: { station: out.station } });
      const r = auto.length ? await runActions(auto) : { chips: [], said: [], detail: [] };
      const spoken = out.spoken || r.said.join(' ') || `${r.chips.filter((c) => !c.refused).map((c) => c.label).join('. ')}.`;
      add({ role: 'aurora', text: spoken, detail: [...(out.detail || []), ...r.detail], chips: r.chips, suggestions: suggest,
        mode: out.mode, notice: out.notice, sources: out.sources, grounding: out.grounding, station: out.station });
      if (out.notice) setStatus((s) => ({ ...(s || {}), llmAvailable: false, notice: out.notice }));
      say(spoken);
    } catch (err) {
      console.warn('[Aurora] chat failed', err);
      const msg = err?.kind === 'http' && err.status === 429
        ? 'Too many questions in a short time; wait a moment and ask again.'
        : `I can't reach the station backend right now (${describeFailure(err)}). Page commands still work.`;
      add({ role: 'aurora', text: msg, error: true });
      say(msg);
    } finally {
      setBusy(false);
    }
  }, [add, hush, incidentControl, runActions, say, setPrefs]);
  useEffect(() => { live.current.entries = entries; });
  // "Ask Aurora: …" from the command palette.
  const ask = useAssistant((s) => s.ask);
  useEffect(() => {
    if (!ask?.text) return;
    setAssistant({ ask: null });
    handle(ask.text, 'text');
  }, [ask, handle]);

  const runSuggestion = useCallback(async (entryId, action) => {
    setEntries((list) => list.map((e) => (e.id === entryId ? { ...e, suggestions: e.suggestions.filter((s) => s !== action) } : e)));
    const r = await runActions([action]);
    add({ role: 'aurora', text: r.said.join(' ') || `${r.chips.map((c) => c.label).join('. ')}.`, chips: r.chips, detail: r.detail });
  }, [add, runActions]);

  // ── Speech in: mic button, hold "V", conversation mode ──
  const stopListening = useCallback(() => {
    const cur = recRef.current;
    if (!cur) return;
    cur.stopping = true;
    try { cur.rec.stop(); } catch (err) { console.warn('[Aurora] stop listening', err); }
  }, []);
  const startListening = useCallback(({ mode = 'single' } = {}) => {
    if (!support.recognition || recRef.current) return;
    hush();
    setMicError(null);
    const finals = [];
    const cur = { mode, conversation: mode === 'conversation', stopping: false, rec: null };
    cur.rec = createRecognizer({
      lang: live.current.prefs.lang,
      continuous: mode !== 'single',
      onInterim: setInterim,
      onFinal: (txt) => {
        if (mode === 'conversation') { setInterim(''); handle(txt, 'voice'); } else finals.push(txt);
      },
      onError: (code) => { const m = recognitionErrorText(code); if (m) { setMicError(m); cur.fatal = true; } },
      onEnd: () => {
        recRef.current = null;
        setListening(false);
        setInterim('');
        if (mode !== 'conversation' && finals.length) handle(finals.join(' '), 'voice');
        if (mode === 'conversation' && !cur.stopping && !cur.fatal && live.current.prefs.conversation && live.current.open) {
          // Keep the conversation going (it pauses itself while Aurora speaks).
          setTimeout(() => { if (!recRef.current && live.current.prefs.conversation && live.current.open) startRef.current?.({ mode: 'conversation' }); }, 400);
        }
      },
    });
    recRef.current = cur;
    try {
      cur.rec.start();
      setListening(true);
    } catch (err) {
      console.warn('[Aurora] could not start listening', err);
      recRef.current = null;
    }
  }, [support.recognition, hush, handle]);
  const startRef = useRef(null);
  useEffect(() => { startRef.current = startListening; });
  useEffect(() => {
    if (ptt) { setAssistant({ open: true }); startListening({ mode: 'ptt' }); } else if (recRef.current?.mode === 'ptt') stopListening();
  }, [ptt, startListening, stopListening]);
  // Conversation mode restarts listening after Aurora finishes speaking.
  useEffect(() => {
    if (!speaking && prefs.conversation && open && support.recognition && !recRef.current && gesture) {
      const t = setTimeout(() => startListening({ mode: 'conversation' }), 300);
      return () => clearTimeout(t);
    }
    if ((!prefs.conversation || !open) && recRef.current?.mode === 'conversation') stopListening();
    return undefined;
  }, [speaking, prefs.conversation, open, support.recognition, gesture, startListening, stopListening]);
  useEffect(() => () => { stopSpeaking(); try { recRef.current?.rec.abort(); } catch (err) { console.warn('[Aurora] cleanup', err); } }, []);

  // Story-mode, tour, or closing the panel: stop talking over it.
  useEffect(() => { if (tourActive) hush(); }, [tourActive, hush]);

  const queued = queue(inc);
  const floatIncident = !open && !tourActive && currentIncident && (snoozed[currentIncident.key] || 0) < now ? currentIncident : null;
  const slot = typeof document !== 'undefined' ? document.getElementById('aurora-highlight-slot') : null;
  const panelProps = {
    open, isPhone, onClose: () => { setAssistant({ open: false }); stopListening(); },
    entries, busy, listening, interim, speaking, support, prefs, setPrefs, status, micError, writeProtected,
    onSend: (t) => handle(t, 'text'), onMic: () => (listening ? stopListening() : startListening({ mode: prefs.conversation ? 'conversation' : 'single' })),
    onUndo: undo, onSuggestion: runSuggestion, onStop: hush, pendingConfirm: Boolean(pending),
    incident: shownIncident, book: bookOf(shownIncident), queued, onFocusIncident: setFocusKey,
    onToggleStep: toggleStep, onIncidentControl: (c) => { const reply = incidentControl(c, shownIncident?.key); if (reply) { add({ role: 'aurora', text: reply }); if (c === 'next-step' || c === 'repeat') say(reply, { force: true }); } },
    onShowChain: (i) => { const b = bookOf(i); if (b) { const nav = autoNavigate(i, b); add({ role: 'aurora', text: `${nav.label}.`, chips: [{ id: uid(), label: nav.label, undo: nav.undo }] }); } },
    snoozedUntil: shownIncident ? snoozed[shownIncident.key] : null, now,
    stationName: stationMeta(activeStation).name, stationId: activeStation, ctxRisk: ctx?.decision?.available ? ctx.decision.risk : null, ctx,
    draft: getAssistant().draft,
  };

  return (
    <>
      {slot && highlight && createPortal(
        <HighlightStrip highlight={highlight} activeStation={activeStation} activeModule={activeModule}
          onOpenMap={() => { controls.navigate('infrastructure'); controls.scrollTo('infra-dependency'); }}
          onClear={() => setAssistant({ highlight: null })} />, slot)}
      {panelMounted && (
        <Suspense fallback={null}>
          <AssistantPanel {...panelProps} />
        </Suspense>
      )}
      {floatIncident && bookOf(floatIncident) && (
        <IncidentCard compact incident={floatIncident} book={bookOf(floatIncident)} isPhone={isPhone}
          queued={queued.length - 1}
          onOpen={() => { setFocusKey(floatIncident.key); setAssistant({ open: true }); }}
          onShowMe={() => {
            const b = bookOf(floatIncident);
            setFocusKey(floatIncident.key);
            setAssistant({ open: true });
            const nav = autoNavigate(floatIncident, b);
            add({ role: 'aurora', text: `${nav.label}.`, chips: [{ id: uid(), label: nav.label, undo: nav.undo }] });
          }}
          onSnooze={() => incidentControl('snooze', floatIncident.key)}
          nextStepLabel={nextStep(floatIncident, bookOf(floatIncident))?.step.do} />
      )}
    </>
  );
}
