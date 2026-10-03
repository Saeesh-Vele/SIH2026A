import { describe, expect, it } from 'vitest';
import FULL from '../../simulator/station_config.json';
import { buildingList, dependencyEdges, sensorCatalog, STATION_IDS, stationMeta } from './stationConfig';
import { sceneInfo, stationMetaDetailed } from './stationConfigDetail';

// The startup module reads a build-time core view of station_config.json (vite.config.js).
// It must agree with the file for everything it keeps.
describe('station config core view', () => {
  it('keeps every station, value, building, edge and threshold', () => {
    expect(STATION_IDS).toEqual(Object.keys(FULL.stations));
    for (const sid of STATION_IDS) {
      const full = FULL.stations[sid];
      Object.entries(full.metadata).forEach(([k, v]) => {
        expect(stationMeta(sid)[k]).toEqual(v && typeof v === 'object' && 'value' in v ? v.value : v);
      });
      expect(buildingList(sid)).toEqual(full.buildings);
      expect(dependencyEdges(sid)).toEqual(full.dependencyGraph.edges);
      Object.entries(full.sensors).forEach(([k, { basis, ...rest }]) => {
        expect(sensorCatalog(sid)[k]).toEqual(rest);
        expect(sensorCatalog(sid)[k].basis).toBeUndefined();
        expect(basis).toBeTruthy();
      });
    }
  });

  it('the detail module still has provenance and scene notes', () => {
    expect(stationMetaDetailed('maitri').latitude.source).toBeTruthy();
    expect(sceneInfo('maitri')).toEqual(FULL.stations.maitri.scene);
  });
});
