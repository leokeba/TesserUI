import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latestReleases, manifest } from '../releases.mjs';

const asset = (tag, name) => ({ name, size: 10, browser_download_url: `https://github.com/o/r/releases/download/${tag}/${name}` });
const release = (tag, names, more) => ({ tag_name: tag, published_at: `${tag}-date`, draft: false, prerelease: false, assets: names.map((n) => asset(tag, n)), ...more });
const github = (body, status = 200) => async (url, init) => {
  github.asked = { url, init };
  return new Response(JSON.stringify(body), { status });
};

test('the latest releases with images, newest first, without drafts and pre-releases', async () => {
  const fetch = github([
    release('v5', ['kit-esp32-factory.bin'], { draft: true }),
    release('v4', ['kit-esp32-factory.bin'], { prerelease: true }),
    release('v3', ['kit-esp32-factory.bin', 'kit-esp32.bin', 'tesserui-bridge-macos-arm64.zip']),
    release('v2', ['notes.txt']),
    release('v1', ['kit-esp32-factory.bin', 'kit-esp32c3-factory.bin']),
    release('v0', ['kit-esp32-factory.bin']),
  ]);
  const found = await latestReleases('o/r', { keep: 2, fetch });
  assert.equal(github.asked.url, 'https://api.github.com/repos/o/r/releases?per_page=30');
  assert.equal(github.asked.init.headers.authorization, undefined);
  assert.deepEqual(found.releases.map((r) => [r.tag, r.assets.map((a) => a.name)]), [
    ['v3', ['kit-esp32-factory.bin']],
    ['v1', ['kit-esp32-factory.bin', 'kit-esp32c3-factory.bin']],
  ]);
  assert.equal(found.releases[0].assets[0].url, 'https://github.com/o/r/releases/download/v3/kit-esp32-factory.bin');

  // What the flasher reads: no download URLs.
  assert.deepEqual(manifest(found), {
    repo: 'o/r',
    releases: [
      { tag: 'v3', date: 'v3-date', assets: [{ name: 'kit-esp32-factory.bin', size: 10 }] },
      { tag: 'v1', date: 'v1-date', assets: [{ name: 'kit-esp32-factory.bin', size: 10 }, { name: 'kit-esp32c3-factory.bin', size: 10 }] },
    ],
  });
});

test('a token, and an error from GitHub', async () => {
  await latestReleases('o/r', { token: 't', fetch: github([]) });
  assert.equal(github.asked.init.headers.authorization, 'Bearer t');
  await assert.rejects(latestReleases('o/r', { fetch: github({ message: 'rate limited' }, 403) }), /o\/r: 403/);
});
