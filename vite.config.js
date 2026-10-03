import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const STATION_CONFIG = fileURLToPath(new URL('./simulator/station_config.json', import.meta.url))
const CORE_ID = 'virtual:station-config-core'

/** The startup view of station_config.json (still the ONE source file): metadata values
 *  without their source/confidence notes, buildings, the dependency graph and sensor
 *  thresholds without the `basis` text; no 3D scene notes or backend-only sections.
 *  The full file loads only with the pages that show the detail (src/data/stationConfigDetail.js). */
export function stationConfigCore(cfg) {
  const value = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v)
  return {
    stations: Object.fromEntries(Object.entries(cfg.stations).map(([sid, st]) => [sid, {
      metadata: Object.fromEntries(Object.entries(st.metadata || {}).map(([k, v]) => [k, value(v)])),
      buildings: st.buildings,
      dependencyGraph: st.dependencyGraph,
      sensors: Object.fromEntries(Object.entries(st.sensors || {}).map(([k, { basis: _basis, ...rest }]) => [k, rest])),
    }])),
  }
}

export function stationConfigCorePlugin() {
  return {
    name: 'aurora-station-config-core',
    resolveId: (id) => (id === CORE_ID ? `\0${CORE_ID}` : null),
    load(id) {
      if (id !== `\0${CORE_ID}`) return null
      this.addWatchFile(STATION_CONFIG)
      const core = stationConfigCore(JSON.parse(readFileSync(STATION_CONFIG, 'utf8')))
      return `export default ${JSON.stringify(core)};`
    },
  }
}

// https://vite.dev/config/
// Vitest's configuration lives in vitest.config.js, so a production build never
// references test-only files (which the Docker build context excludes).
export default defineConfig({
  plugins: [react(), stationConfigCorePlugin()],
  build: {
    // The entry chunk is ~440 kB; the only chunk above 500 kB is three.js, and that
    // one is lazily loaded with the 3D twin, so it never delays first paint.
    chunkSizeWarningLimit: 600,
  },
})
