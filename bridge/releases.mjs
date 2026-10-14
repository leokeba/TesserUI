// The firmware a launcher offers (DESIGN.md §9.7.1): the latest releases of a
// GitHub repository with their images, newest first, without drafts and
// pre-releases. web/scripts/firmware.mjs copies them into a launcher's site;
// the bridge serves them at /firmware/.
//
// Each asset keeps its download URL, which the manifest the flasher reads
// leaves out (manifest()).

export async function latestReleases(repo, { keep = 3, match = '-factory.bin', token, fetch = globalThis.fetch } = {}) {
  const headers = { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers });
  if (!r.ok) throw new Error(`${repo}: ${r.status} ${await r.text()}`);
  const releases = [];
  for (const rel of await r.json()) {
    if (releases.length >= keep) break;
    if (rel.draft || rel.prerelease) continue;
    const assets = rel.assets.filter((a) => a.name.endsWith(match));
    if (assets.length) {
      releases.push({ tag: rel.tag_name, date: rel.published_at, assets: assets.map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })) });
    }
  }
  return { repo, releases };
}

// What the flasher reads: {repo, releases: [{tag, date, assets: [{name, size}]}]}.
export const manifest = ({ repo, releases }) => ({
  repo,
  releases: releases.map(({ tag, date, assets }) => ({ tag, date, assets: assets.map(({ name, size }) => ({ name, size })) })),
});
