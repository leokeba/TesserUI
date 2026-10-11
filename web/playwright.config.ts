import { defineConfig } from '@playwright/test';

// End-to-end tests of the built bundle against the host demo device
// (build/tesserui_demo, real TesserAPI): `cmake --build build` and
// `pnpm build` first. DESIGN.md §11.
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure' },
  webServer: [
    { command: 'node scripts/device.mjs demo --port 8091 --isolated', port: 8091, reuseExistingServer: false },
    { command: 'npx vite preview --port 4173 --strictPort', port: 4173, reuseExistingServer: false },
    // The bridge (../bridge), with the demo device as its only node.
    { command: 'node ../bridge/bridge.mjs --port 8766 --node localhost:8091 --no-mdns --no-serial', port: 8766, reuseExistingServer: false },
  ],
});
