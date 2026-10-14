#!/usr/bin/env node
// The bridge as a macOS executable, for Macs without Node: Bun compiles
// bridge.mjs with a project's launcher built in (its page, ui.js,
// launcher.js and the flasher, from TesserUI's web/dist after `pnpm build`
// there), its launcher's URL and the repository whose releases it installs.
// One file per architecture, each zipped so a download keeps it executable.
// TesserUI's CI builds its own; .github/workflows/bridge.yml builds another
// project's.
//
// serialport stays out: Bun's bundler breaks its bindings (1.3.6), so the
// executable carries no serial ports; browsers with Web Serial don't need
// them. The executables are signed ad hoc, again after Bun (its payload,
// added after the linker's signature, leaves that invalid): macOS asks once
// to open them anyway (System Settings, Privacy & Security).
//
//   node scripts/macos.mjs [--page ../web/pages/index.html] [--name tesserui-bridge]
//                          [--launcher https://leokeba.github.io/TesserUI/] [--repo leokeba/TesserUI]
//                          [--ui ../web/dist] [--out dist]
//
// writes <out>/<name>-macos-arm64.zip and <out>/<name>-macos-x64.zip, each
// holding the executable <name>. Paths are from the current directory.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const page = resolve(option('page', join(here, '../web/pages/index.html')));
const name = option('name', 'tesserui-bridge');
const launcher = option('launcher', 'https://leokeba.github.io/TesserUI/');
const repo = option('repo', 'leokeba/TesserUI');
const ui = resolve(option('ui', join(here, '../web/dist')));
const out = resolve(option('out', join(here, 'dist')));
if (!/^[\w.-]+$/.test(name) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error('--name is a file name, --repo owner/repo');
  process.exit(2);
}
for (const f of [page, join(ui, 'ui.js'), join(ui, 'launcher.js'), join(ui, 'flash/flash.js')]) {
  if (!existsSync(f)) {
    console.error(`${f} is missing${f.startsWith(ui) ? ': run pnpm build in web/ first' : ''}`);
    process.exit(1);
  }
}

// The entry sets what's built in before the bridge starts, which reads it.
const files = { 'index.html': readFileSync(page, 'utf8') };
for (const f of ['ui.js', 'launcher.js', ...readdirSync(join(ui, 'flash')).filter((f) => f.endsWith('.js')).map((f) => `flash/${f}`)]) {
  files[f] = readFileSync(join(ui, f), 'utf8');
}
const build = join(here, 'build');
rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(build, 'entry.mjs'), `globalThis.tesseruiBridge = ${JSON.stringify({ name, launcher, repo, files })};\nawait import('../bridge.mjs');\n`);

for (const arch of ['arm64', 'x64']) {
  const exe = join(build, arch, name);
  const zip = join(out, `${name}-macos-${arch}.zip`);
  execFileSync('bun', ['build', '--compile', `--target=bun-darwin-${arch}`, '--external', 'serialport', join(build, 'entry.mjs'), '--outfile', exe], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', exe], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', exe], { stdio: 'inherit' });
  rmSync(zip, { force: true });
  execFileSync('zip', ['-j', '-X', '-q', zip, exe], { stdio: 'inherit' });
  console.log(zip);
}
