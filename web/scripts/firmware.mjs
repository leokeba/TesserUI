// Copies the latest releases' firmware images of a GitHub repository next to
// a launcher (DESIGN.md §9.7.1), with the manifest the flasher reads. A page
// can read GitHub's API, but not its release assets: they come from a host
// that sends no CORS headers. So CI copies them into the site.
//
//   node scripts/firmware.mjs <owner/repo> <dir> [--releases 3] [--match -factory.bin]
//
// writes <dir>/manifest.json and <dir>/<tag>/<asset>. GITHUB_TOKEN (or
// GH_TOKEN), when set, lifts the API's limit of 60 requests an hour.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
const headers = { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers });
if (!r.ok) {
  console.error(`${repo}: ${r.status} ${await r.text()}`);
  process.exit(1);
}

// Newest first, as GitHub lists them; drafts and pre-releases aren't offered.
const releases = [];
for (const rel of await r.json()) {
  if (releases.length >= keep) break;
  if (rel.draft || rel.prerelease) continue;
  const assets = rel.assets.filter((a) => a.name.endsWith(match));
  if (!assets.length) continue;
  mkdirSync(join(dir, rel.tag_name), { recursive: true });
  for (const a of assets) {
    const res = await fetch(a.browser_download_url);
    if (!res.ok) throw new Error(`${a.name}: ${res.status}`);
    writeFileSync(join(dir, rel.tag_name, a.name), Buffer.from(await res.arrayBuffer()));
  }
  releases.push({ tag: rel.tag_name, date: rel.published_at, assets: assets.map((a) => ({ name: a.name, size: a.size })) });
  console.log(`${rel.tag_name}: ${assets.map((a) => a.name).join(', ')}`);
}
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ repo, releases }, null, 2) + '\n');
console.log(`${dir}/manifest.json: ${releases.length} release(s) of ${repo}`);
