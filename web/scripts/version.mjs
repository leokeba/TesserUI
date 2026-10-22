// TesserUI's version (DESIGN.md §12): library.json's, which CI's release
// numbering reads, copied into each file that states it. npm, PlatformIO,
// Arduino and ESP-IDF each read their own manifest without running
// anything, and C++ needs a literal, so the copies stay: this writes them.
//
//   node scripts/version.mjs           checks that the copies agree
//   node scripts/version.mjs 0.2.0     sets the version everywhere

import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const json = /("version": ")([^"]*)/;
// Each file, and where it states the version (its first match): what comes
// before it, and the version.
const FILES = [
  ['library.json', json],
  ['web/package.json', json],
  ['bridge/package.json', json],
  ['library.properties', /^(version=)(.*)$/m],
  ['idf_component.yml', /^(version: ")([^"]*)/m],
  ['src/tesserui/version.h', /(#define TESSERUI_VERSION ")([^"]*)/],
];

const read = (file) => readFileSync(new URL(file, root), 'utf8');

// Each file's version, undefined where it states none.
const versions = () => FILES.map(([file, re]) => [file, re.exec(read(file))?.[2]]);

const [next] = process.argv.slice(2);
if (next !== undefined && !/^\d+\.\d+\.\d+$/.test(next)) {
  console.error('usage: node scripts/version.mjs [X.Y.Z]');
  process.exit(2);
}
if (next) for (const [file, re] of FILES) writeFileSync(new URL(file, root), read(file).replace(re, `$1${next}`));
const found = versions();
const differ = found.filter(([, v]) => v !== found[0][1]);
for (const [file, v] of found) console.log(`${v ?? '(none)'}\t${file}`);
if (differ.length) process.exit(1);
