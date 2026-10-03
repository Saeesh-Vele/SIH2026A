/* Aurora — the detailed half of station_config.json: provenance notes and the 3D scene
   notes. Imported only by pages that show them (Administration, Reports, the 3D twin),
   so the full file stays out of the startup bundle (see src/data/stationConfig.js). */
import CONFIG from '../../simulator/station_config.json';

/** Metadata with provenance notes ({value, source, confidence, needsNcporConfirmation}). */
export function stationMetaDetailed(stationId) {
  return CONFIG.stations[stationId]?.metadata || {};
}

/** The 3D overview's layout notes: {layout, prevailingWindFromDeg, zones: {id: {physical, source, confidence}}}. */
export function sceneInfo(stationId) {
  return CONFIG.stations[stationId]?.scene || null;
}
