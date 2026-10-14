// Copies the latest releases' firmware images of a GitHub repository next to
// a launcher (DESIGN.md §9.7.1), with the manifest the flasher reads. A page
// can read GitHub's API, but not its release assets: they come from a host
// that sends no CORS headers. So CI copies them into the site.
//
//   node scripts/firmware.mjs <owner/repo> <dir> [--releases 3] [--match -factory.bin]
//
// writes <dir>/manifest.json and <dir>/<tag>/<asset>, the releases as the
// bridge serves them (bridge/releases.mjs). GITHUB_TOKEN (or
// GH_TOKEN), when set, lifts the API's limit of 60 requests an hour.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { latestReleases, manifest } from '../../bridge/releases.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args.splice(i, 2)[1];
};
const keep = Number(option('releases', '3'));
const match = option('match', '-factory.bin');
const [repo, dir] = args;
if (!repo || !dir || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error('usage: node scripts/firmware.mjs <owner/repo> <dir> [--releases 3] [--match -factory.bin]');
  process.exit(2);
}

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
let found;
try {
  found = await latestReleases(repo, { keep, match, token });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
for (const rel of found.releases) {
  mkdirSync(join(dir, rel.tag), { recursive: true });
  for (const a of rel.assets) {
    const res = await fetch(a.url);
    if (!res.ok) throw new Error(`${a.name}: ${res.status}`);
    writeFileSync(join(dir, rel.tag, a.name), Buffer.from(await res.arrayBuffer()));
  }
  console.log(`${rel.tag}: ${rel.assets.map((a) => a.name).join(', ')}`);
}
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest(found), null, 2) + '\n');
console.log(`${dir}/manifest.json: ${found.releases.length} release(s) of ${repo}`);
