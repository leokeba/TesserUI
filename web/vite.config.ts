/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// The bundle is one IIFE script, ui.js, with its CSS injected by Svelte:
// the node serves two files (DESIGN.md §9.4). scripts/bundle.mjs then writes
// dist/index.html, the gzipped copies and the C++ header. `--mode lib`
// builds the npm package's module entry, tesserui.js (§9.9), next to it.
export default defineConfig(({ mode }) => ({
  plugins: [svelte({ emitCss: false })],
  define: { __VERSION__: JSON.stringify(pkg.version) },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: mode !== 'lib',
    lib:
      mode === 'lib'
        ? { entry: 'src/lib.ts', formats: ['es'], fileName: () => 'tesserui.js' }
        : { entry: 'src/main.ts', formats: ['iife'], name: 'TesserUI', fileName: () => 'ui.js' },
  },
  test: { include: ['test/**/*.test.ts'] },
}));
