/* ═══════════════════════════════════════════════════════════════
   Aurora assistant — incident mode, the pure part (no React, no timers).

   observe(state, observation, playbooks, now) → {state, events}

   An observation is one station's current picture: its active alerts (shared, or
   the visitor's own sandbox alerts), the running demo scenario, the satellite
   link, the anomaly detector and the decision engine's risk, and the cascades.

   Incidents start on a NEW critical alert, a satellite link loss, or a serious
   anomaly (detector flag + a residual over its alarm gate). Each is matched to a
   playbook (scenario first, then alert sensors, then anomaly causes — the same
   order as simulator/assistant.py). While it runs it collects affected systems
   (alert buildings + the backend's cascade chains) and follows the risk; it is
   resolved once its trigger has been absent for RESOLVE_AFTER observations.

   Risk: max(the playbook's baselineRisk, the decision engine's level). The engine can
   lag the alerts by a tick or two, so an incident never states less than the baseline
   for its failure type; once the engine reaches the baseline the incident is marked
   `engineConfirmed` (an update says so), and a higher engine rating escalates it.

   Events: new | update | escalate | resolved. Incidents already present on the
   first observation of a station are flagged `atLoad` (shown, never announced).
   ═══════════════════════════════════════════════════════════════ */

export const RESOLVE_AFTER = 2;
const SEVERITY_RANK = { critical: 2, warning: 1 };
export const RISK_RANK = { nominal: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const rank = (r) => (r == null ? -1 : RISK_RANK[r] ?? -1);

/** The risk an incident may state: never below its playbook's baseline for the failure type,
 *  raised by the decision engine when the engine rates it higher. */
export function effectiveRisk(baseline, engine) {
  return rank(engine) > rank(baseline) ? engine : (baseline || engine || null);
}

export const emptyState = () => ({ incidents: {}, seen: {} });

/** The playbook for a scenario / alert sensors / anomaly causes (mirrors assistant.select_playbook). */
export function selectPlaybook(books, { scenario = null, sensors = [], causes = [] } = {}) {
  if (scenario) {
    const p = books.find((b) => b.match.scenarios.includes(scenario));
    if (p) return p;
  }
  if (sensors.length) {
    const p = books.find((b) => sensors.some((s) => b.match.sensors.includes(s)));
    if (p) return p;
  }
  if (causes.length) {
    const p = books.find((b) => causes.some((c) => b.match.anomalyCauses.includes(c)));
    if (p) return p;
  }
  return books.find((b) => b.id === 'anomaly');
}

const alertBuilding = (a) => a.buildingId || a.building;

/** Group what is wrong right now into {playbookId: {severity, alerts, buildings, kind}}. */
function triggers(obs, books) {
  const groups = {};
  const scenarioBook = obs.scenario ? books.find((b) => b.match.scenarios.includes(obs.scenario)) : null;
  const bookFor = (sensor) => (scenarioBook?.match.sensors.includes(sensor) ? scenarioBook : selectPlaybook(books, { sensors: [sensor] }));
  const add = (book, severity, kind) => {
    const g = groups[book.id] || (groups[book.id] = { severity, alerts: [], buildings: new Set(), kind });
    if ((SEVERITY_RANK[severity] || 0) > (SEVERITY_RANK[g.severity] || 0)) g.severity = severity;
    return g;
  };
  const alerts = obs.alerts || [];
  alerts.filter((a) => a.level === 'critical').forEach((a) => {
    const g = add(bookFor(a.sensor), 'critical', 'alert');
    g.alerts.push(a);
    g.buildings.add(alertBuilding(a));
  });
  // Related warnings join an incident that already exists; on their own they are not one.
  alerts.filter((a) => a.level !== 'critical').forEach((a) => {
    const g = groups[bookFor(a.sensor).id];
    if (g) { g.alerts.push(a); g.buildings.add(alertBuilding(a)); }
  });
  if (obs.linkUp === false) {
    const g = add(books.find((b) => b.id === 'link_loss'), 'warning', 'link');
    g.buildings.add('commsMast');
  }
  const an = obs.anomaly;
  if (an?.serious) {
    const book = selectPlaybook(books, { causes: an.causes || [] });
    if (!groups[book.id]) {
      const g = add(book, 'warning', 'anomaly');
      (an.buildings || []).forEach((b) => g.buildings.add(b));
    }
  }
  return groups;
}

/** Buildings affected through the backend's cascade chains that start at one of `sources`. */
function cascadeAffected(cascades, sources) {
  const out = new Set();
  (cascades || []).forEach((c) => {
    const chain = c.chain?.length ? c.chain : [c.sourceBuilding, c.affectedBuilding];
    if (sources.has(chain[0])) chain.slice(1).forEach((b) => out.add(b));
  });
  return out;
}

export function observe(state, obs, books, now) {
  const events = [];
  const incidents = { ...state.incidents };
  const first = !state.seen[obs.station];
  const groups = triggers(obs, books);
  const engine = obs.risk || null;

  Object.entries(groups).forEach(([pid, g]) => {
    const key = `${obs.station}:${pid}`;
    const sources = g.buildings;
    const affected = [...new Set([...sources, ...cascadeAffected(obs.cascades, sources)])];
    const cur = incidents[key];
    if (!cur || cur.status === 'resolved') {
      const baseline = books.find((b) => b.id === pid)?.baselineRisk || null;
      const risk = effectiveRisk(baseline, engine);
      const inc = {
        id: `${key}:${now}`, key, station: obs.station, playbookId: pid, kind: g.kind, severity: g.severity,
        status: 'active', startedAt: now, atLoad: first, alertIds: g.alerts.map((a) => a.id),
        sources: [...sources], affected, everAffected: affected, risk, peakRisk: risk,
        baselineRisk: baseline, engineRisk: engine, engineConfirmed: rank(engine) >= rank(baseline) && engine != null,
        sandbox: g.alerts.length > 0 && g.alerts.every((a) => a.sandboxThreshold || a.sandbox),
        scenario: obs.scenario || null, done: [], clear: 0, updatedAt: now,
      };
      incidents[key] = inc;
      events.push({ type: 'new', incident: inc });
      return;
    }
    const added = affected.filter((b) => !cur.everAffected.includes(b));
    const escalated = (SEVERITY_RANK[g.severity] || 0) > (SEVERITY_RANK[cur.severity] || 0);
    const eng = engine || cur.engineRisk;
    const risk = effectiveRisk(cur.baselineRisk, eng);
    const riskUp = rank(risk) > rank(cur.risk);
    const riskChanged = risk !== cur.risk;
    const confirmed = !cur.engineConfirmed && eng != null && rank(eng) >= rank(cur.baselineRisk);
    const next = {
      ...cur, severity: escalated ? g.severity : cur.severity, sources: [...sources], affected,
      everAffected: [...cur.everAffected, ...added], alertIds: [...new Set([...cur.alertIds, ...g.alerts.map((a) => a.id)])],
      risk, engineRisk: eng, engineConfirmed: cur.engineConfirmed || confirmed, clear: 0,
      peakRisk: rank(risk) > rank(cur.peakRisk) ? risk : cur.peakRisk,
    };
    if (added.length || escalated || riskChanged || confirmed) next.updatedAt = now;
    incidents[key] = next;
    if (escalated || (riskUp && cur.risk != null)) events.push({ type: 'escalate', incident: next, added, risk: riskUp ? risk : null, from: cur.risk, confirmed });
    else if (added.length || riskChanged || confirmed) {
      events.push({ type: 'update', incident: next, added, risk: riskChanged ? risk : null, from: cur.risk, confirmed });
    }
  });

  Object.values(incidents).forEach((inc) => {
    if (inc.station !== obs.station || inc.status !== 'active' || groups[inc.playbookId]) return;
    const clear = inc.clear + 1;
    if (clear < RESOLVE_AFTER) { incidents[inc.key] = { ...inc, clear }; return; }
    const done = { ...inc, clear, status: 'resolved', resolvedAt: now, updatedAt: now };
    incidents[inc.key] = done;
    events.push({ type: 'resolved', incident: done });
  });

  return { state: { incidents, seen: { ...state.seen, [obs.station]: true } }, events };
}

/** Active incidents, most severe first, then oldest first. */
export function queue(state) {
  return Object.values(state.incidents).filter((i) => i.status === 'active' && !i.dismissed)
    .sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || (a.startedAt - b.startedAt));
}

/** The observation for one station from the telemetry snapshot + the assistant context. */
export function observationFrom(station, stationData, ctx) {
  const an = ctx?.station?.id === station ? ctx.anomaly : null;
  const serious = Boolean(an?.available && an.isAnomaly && an.maxResidualSigma != null && an.residualAlarmSigma != null
    && an.maxResidualSigma >= an.residualAlarmSigma);
  const tele = ctx?.telemetry || [];
  return {
    station,
    alerts: stationData?.activeAlerts || [],
    scenario: stationData?.publicDemo?.[station]?.scenario || stationData?.provenance?.activeScenario || null,
    linkUp: stationData?.link ? stationData.link.up !== false : true,
    anomaly: serious ? {
      serious, causes: (an.candidateCauses || []).map((c) => c.cause),
      buildings: [...new Set((an.evidence || []).map((e) => tele.find((r) => r.sensor === e.sensor)?.building).filter(Boolean))],
    } : null,
    risk: ctx?.station?.id === station && ctx.decision?.available ? ctx.decision.risk?.level || null : null,
    cascades: stationData?.dependencyAlerts || [],
  };
}
