/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// The bundle is one IIFE script, ui.js, with its CSS injected by Svelte:
// the node serves two files (DESIGN.md §9.4). scripts/bundle.mjs then writes
// dist/index.html, the gzipped copies and the C++ header. `--mode lib`
// builds the npm package's module entry, tesserui.js (§9.9), next to it, and
// `--mode flash` the launcher's flasher, dist/flash/flash.js and the chunks
// esptool-js loads per chip (§9.7.1), and `--mode launcher` the launcher's
// own script, dist/launcher.js (§9.7.2).
export default defineConfig(({ mode }) => ({
  plugins: [svelte({ emitCss: false })],
  define: { __VERSION__: JSON.stringify(pkg.version) },
  build: {
    target: 'es2022',
    outDir: mode === 'flash' ? 'dist/flash' : 'dist',
    emptyOutDir: mode !== 'lib' && mode !== 'launcher',
    // An ES library keeps its whitespace by default: the launcher's script,
    // which pages load, doesn't.
    rolldownOptions: mode === 'launcher' ? { output: { minify: true } } : undefined,
    lib:
      mode === 'lib'
        ? { entry: 'src/lib.ts', formats: ['es'], fileName: () => 'tesserui.js' }
        : mode === 'flash'
          ? { entry: 'src/flash/flash.ts', formats: ['es'], fileName: () => 'flash.js' }
          : mode === 'launcher'
            ? { entry: 'src/launcher/launcher.ts', formats: ['es'], fileName: () => 'launcher.js' }
            : { entry: 'src/main.ts', formats: ['iife'], name: 'TesserUI', fileName: () => 'ui.js' },
  },
  test: { include: ['test/**/*.test.ts'] },
}));
