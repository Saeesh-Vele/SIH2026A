import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { stationConfigCorePlugin } from './vite.config.js'

// Test-only configuration, kept out of vite.config.js so `vite build` never needs
// src/test/ or the *.test.* files.
export default defineConfig({
  plugins: [react(), stationConfigCorePlugin()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
    include: ['src/**/*.test.{js,jsx}'],
    // tests/e2e is Playwright's; it must never be collected by Vitest.
    exclude: ['node_modules/**', 'dist/**', 'tests/e2e/**'],
    restoreMocks: true,
    coverage: { reporter: ['text', 'text-summary'], include: ['src/**/*.{js,jsx}'] },
  },
})
