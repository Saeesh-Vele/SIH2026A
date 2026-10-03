/* ═══════════════════════════════════════════════════════════════
   Aurora — station configuration (single source of truth)
   Built from simulator/station_config.json — the same file the backend serves
   at GET /api/config/stations. Station metadata, buildings, the dependency graph
   and default alert thresholds all come from here, so the browser demo mode
   works without the backend.

   This module is in the startup bundle, so it imports the file's *core view*
   (vite.config.js: metadata values, buildings, graph, thresholds; no provenance
   notes, threshold basis or 3D scene notes). Pages that show those details
   import src/data/stationConfigDetail.js, which loads the whole file with them.
   ═══════════════════════════════════════════════════════════════ */
import CONFIG from 'virtual:station-config-core';

export const STATION_IDS = Object.keys(CONFIG.stations);

/** Plain {key: value} metadata (the source/confidence notes are in stationConfigDetail.js). */
export function stationMeta(stationId) {
  return CONFIG.stations[stationId]?.metadata || {};
}

/** "70.77°S, 11.73°E" */
export function formatCoords(stationId) {
  const { latitude, longitude } = stationMeta(stationId);
  if (latitude == null || longitude == null) return '—';
  const lat = `${Math.abs(latitude).toFixed(2)}°${latitude < 0 ? 'S' : 'N'}`;
  const lon = `${Math.abs(longitude).toFixed(2)}°${longitude < 0 ? 'W' : 'E'}`;
  return `${lat}, ${lon}`;
}

/** "≈ 25 winter crew": the figure is approximate (medium/low confidence in station_config). */
export function crewLabel(stationId) {
  const n = stationMeta(stationId).personnelWinter;
  return typeof n === 'number' ? `≈ ${n} winter crew` : null;
}

export function buildingList(stationId) {
  return CONFIG.stations[stationId]?.buildings || [];
}

export function dependencyEdges(stationId) {
  return CONFIG.stations[stationId]?.dependencyGraph?.edges || [];
}

/** {building: {depends: [...], feeds: [...]}} built from the edge list. */
export function dependencyGraph(stationId) {
  const graph = Object.fromEntries(buildingList(stationId).map((b) => [b.id, { depends: [], feeds: [] }]));
  dependencyEdges(stationId).forEach(({ source, target }) => {
    graph[source]?.feeds.push(target);
    graph[target]?.depends.push(source);
  });
  return graph;
}

/** {sensorId: {building, name, unit, thresholdRange, low?, high?}} (the `basis` text is served by the backend) */
export function sensorCatalog(stationId) {
  return CONFIG.stations[stationId]?.sensors || {};
}
