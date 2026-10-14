#!/usr/bin/env node
// The bridge as a macOS executable, for Macs without Node: Bun compiles
// bridge.mjs and the launcher's files (../web/dist, from `pnpm build` there)
// into one file per architecture, each zipped so a download keeps it
// executable. CI attaches them to each release.
//
// serialport stays out: Bun's bundler breaks its bindings (1.3.6), so the
// executable carries no serial ports; browsers with Web Serial don't need them.
// The executables are signed ad hoc (Bun does it): macOS asks once to open
// them anyway (System Settings, Privacy & Security).
//
//   node scripts/macos.mjs   →  dist/tesserui-bridge-macos-arm64.zip, dist/tesserui-bridge-macos-x64.zip

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = (p) => fileURLToPath(new URL(p, new URL('../', import.meta.url)));
const launcher = path('../web/dist/');
const names = ['index.html', 'ui.js', 'launcher.js'];
for (const n of names) {
  if (!existsSync(launcher + n)) {
    console.error(`${launcher}${n} is missing: run pnpm build in web/ first`);
    process.exit(1);
  }
}

// The entry sets the files before the bridge starts, which reads them.
rmSync(path('build/'), { recursive: true, force: true });
rmSync(path('dist/'), { recursive: true, force: true });
mkdirSync(path('build/'), { recursive: true });
mkdirSync(path('dist/'), { recursive: true });
const files = Object.fromEntries(names.map((n) => [n, readFileSync(launcher + n, 'utf8')]));
writeFileSync(path('build/entry.mjs'), `globalThis.tesseruiLauncher = ${JSON.stringify(files)};\nawait import('../bridge.mjs');\n`);

for (const arch of ['arm64', 'x64']) {
  const exe = path(`build/${arch}/tesserui-bridge`);
  const zip = path(`dist/tesserui-bridge-macos-${arch}.zip`);
  execFileSync('bun', ['build', '--compile', `--target=bun-darwin-${arch}`, '--external', 'serialport', path('build/entry.mjs'), '--outfile', exe], { stdio: 'inherit' });
  execFileSync('zip', ['-j', '-X', '-q', zip, exe], { stdio: 'inherit' });
  console.log(zip);
}
