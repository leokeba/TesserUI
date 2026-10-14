import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentType, fileOption } from '../files.mjs';

test('a file under its base name, or a name of its own', () => {
  assert.deepEqual(fileOption('web/elements/midi.js'), { name: 'midi.js', path: 'web/elements/midi.js' });
  assert.deepEqual(fileOption('img/logo.svg=assets/logo.svg'), { name: 'img/logo.svg', path: 'assets/logo.svg' });
  assert.deepEqual(fileOption('a=/abs/path=with=equals.js'), { name: 'a', path: '/abs/path=with=equals.js' });
});

test("no traversal, and none of the bridge's own paths", () => {
  for (const bad of ['../x.js=x.js', 'a/../b.js=x', './x.js=x', 'a//b=x', '=x.js', 'x.js=', 'ui.js=x', 'index.html=x', 'launcher.js=x', 'flash/flash.js=x', 'firmware/manifest.json=x', 'n/x=x', 's/x=x', 'nodes=x', 'a b.js=x']) {
    assert.throws(() => fileOption(bad), /--file/, bad);
  }
  // Names that only begin like the bridge's own are fine.
  assert.equal(fileOption('flasher.js=x').name, 'flasher.js');
  assert.equal(fileOption('nodes.json=x').name, 'nodes.json');
});

test('content types by extension', () => {
  assert.equal(contentType('midi.js'), 'text/javascript');
  assert.equal(contentType('img/logo.SVG'), 'image/svg+xml');
  assert.equal(contentType('style.css'), 'text/css');
  assert.equal(contentType('photo.png'), 'image/png');
  assert.equal(contentType('data.bin'), 'application/octet-stream');
});
