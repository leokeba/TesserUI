// The launcher's site on GitHub Pages (DESIGN.md §9.6, §9.7), once CI built
// it: stamps the version just released into its bundles, keeps that
// version's ui.js and chunk at v<version>/ for stub pages pinned to it, and
// every earlier version from its release, and lists them all with their
// Subresource Integrity in versions.json.
//
//   node scripts/site.mjs <site> [--version X.Y.Z] [--pack <file>] [--repo <owner/repo>]
//
// The site's bundles were built with TESSERUI_VERSION=0.0.0-site. Without a
// version (the release failed), they say package.json's, and no folder is
// added. --pack writes the new folder as a .tar.gz, which CI attaches to the
// release as tesserui-web-<version>.tar.gz; --repo reads every release's
// back. GITHUB_TOKEN (or GH_TOKEN), when set, lifts the API's limit of 60
// requests an hour.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PLACEHOLDER = '0.0.0-site';
const ASSET = /^tesserui-web-(\d+\.\d+\.\d+)\.tar\.gz$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const version = option('version') || undefined;
const pack = option('pack');
const repo = option('repo');
const [site] = args;
if (!site || (version && !SEMVER.test(version)) || (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo))) {
  console.error('usage: node scripts/site.mjs <site> [--version X.Y.Z] [--pack <file>] [--repo <owner/repo>]');
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const stamp = version ?? pkg.version;
for (const name of ['ui.js', 'launcher.js']) {
  const file = join(site, name);
  const text = readFileSync(file, 'utf8');
  if (!text.includes(PLACEHOLDER)) throw new Error(`${file}: not built with TESSERUI_VERSION=${PLACEHOLDER}`);
  writeFileSync(file, text.replaceAll(PLACEHOLDER, stamp));
}
console.log(`ui.js and launcher.js say ${stamp}`);

// What a stub loads: ui.js, and its chunk from beside it (§9.4).
if (version) {
  const dir = join(site, `v${version}`);
  mkdirSync(dir, { recursive: true });
  cpSync(join(site, 'ui.js'), join(dir, 'ui.js'));
  cpSync(join(site, 'ui'), join(dir, 'ui'), { recursive: true });
  if (pack) execFileSync('tar', ['-czf', pack, '-C', dir, '.']);
  console.log(`${dir}/${pack ? `, packed in ${pack}` : ''}`);
}

if (repo) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers = { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const tmp = mkdtempSync(join(tmpdir(), 'tesserui-site-'));
  for (let page = 1; ; page++) {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, { headers });
    if (!r.ok) throw new Error(`${repo}: ${r.status} ${await r.text()}`);
    const releases = await r.json();
    for (const a of releases.flatMap((rel) => rel.assets)) {
      const v = ASSET.exec(a.name)?.[1];
      if (!v || existsSync(join(site, `v${v}`))) continue;
      const res = await fetch(a.browser_download_url);
      if (!res.ok) throw new Error(`${a.name}: ${res.status}`);
      const file = join(tmp, a.name);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      mkdirSync(join(site, `v${v}`));
      execFileSync('tar', ['-xzf', file, '-C', join(site, `v${v}`)]);
    }
    if (releases.length < 100) break;
  }
}

// Newest first: {"latest": "0.1.20", "versions": {"0.1.20": "sha384-...", ...}}.
const sri = (file) => 'sha384-' + createHash('sha384').update(readFileSync(file)).digest('base64');
const versions = readdirSync(site)
  .map((d) => /^v(\d+\.\d+\.\d+)$/.exec(d)?.[1])
  .filter(Boolean)
  .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
writeFileSync(
  join(site, 'versions.json'),
  JSON.stringify({ latest: stamp, versions: Object.fromEntries(versions.map((v) => [v, sri(join(site, `v${v}`, 'ui.js'))])) }, null, 2) + '\n',
);
console.log(`${site}/versions.json: ${versions.length} version(s)`);
