/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { classicEntry, staticWidgets } from './scripts/chunks.mjs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// The bundle is a classic script, ui.js, with its CSS injected by Svelte,
// and the chunk of the widgets few pages use, dist/ui/widgets-<hash>.js,
// which it loads when a page draws one (DESIGN.md §9.4): scripts/chunks.mjs
// links them. scripts/bundle.mjs then writes dist/index.html, the gzipped
// copies and the C++ header. `--mode lib` builds the npm package's module
// entry, tesserui.js (§9.9), next to it, and `--mode flash` the launcher's
// flasher, dist/flash/flash.js and the chunks esptool-js loads per chip
// (§9.7.1), and `--mode launcher` the launcher's own script,
// dist/launcher.js (§9.7.2).
export default defineConfig(({ mode }) => ({
  plugins: [
    svelte({ emitCss: false }),
    mode === 'production' && classicEntry(),
    (mode === 'lib' || mode === 'launcher') && staticWidgets(),
  ],
  // CI stamps the version it releases into the launcher's site's copy
  // (scripts/site.mjs); the repository's builds say package.json's.
  define: { __VERSION__: JSON.stringify(process.env.TESSERUI_VERSION || pkg.version) },
  build: {
    target: 'es2022',
    outDir: mode === 'flash' ? 'dist/flash' : 'dist',
    emptyOutDir: mode !== 'lib' && mode !== 'launcher',
    // An ES library keeps its whitespace by default: the scripts pages load
    // don't. ui.js's modules all go in one chunk, core, which chunks.mjs
    // makes ui.js, and the widgets it loads on demand in another: one
    // compressed stream costs less flash than one per widget (3 KB more than
    // a single bundle, against 6.6 KB for nine chunks, 2026-10-22).
    rolldownOptions:
      mode === 'launcher'
        ? { output: { minify: true } }
        : mode === 'lib' || mode === 'flash'
          ? undefined
          : {
              output: {
                minify: true,
                chunkFileNames: 'ui/[name]-[hash].js',
                // The file browser and the editor are chunks of their own
                // (DESIGN.md §4.1, §4.2): pages without files never load
                // them, and their budgets are their own. The widgets' group
                // comes first, so what they share (Svelte's helpers) stays
                // in it rather than the widgets loading a browser's chunk.
                codeSplitting: {
                  groups: [
                    { name: 'core', tags: ['$initial'] },
                    { name: 'widgets', test: (id: string) => !/\/widgets\/(files|editor)\//.test(id) },
                    { name: 'files', test: /\/widgets\/files\// },
                    { name: 'editor', test: /\/widgets\/editor\// },
                  ],
                },
              },
            },
    lib:
      mode === 'lib'
        ? { entry: 'src/lib.ts', formats: ['es'], fileName: () => 'tesserui.js' }
        : mode === 'flash'
          ? { entry: 'src/flash/flash.ts', formats: ['es'], fileName: () => 'flash.js' }
          : mode === 'launcher'
            ? { entry: 'src/launcher/launcher.ts', formats: ['es'], fileName: () => 'launcher.js' }
            : { entry: 'src/main.ts', formats: ['es'], fileName: () => 'ui.js' },
  },
  test: { include: ['test/**/*.test.ts'] },
}));
