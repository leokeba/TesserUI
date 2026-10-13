import { expect, test, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Files over HTTP (DESIGN.md §4): the raw bytes both ways, from the host
// demo node (scripts/device.mjs moves them as TesserAPI's HttpServer does).
test('files over HTTP, the raw bytes', async ({ page }) => {
  await page.goto('/?api=http://localhost:8091/api#/system');
  const backup = page.locator('.row', { has: page.locator('label span:text-is("Backup")') });
  await backup.locator('input[type=file]').setInputFiles({ name: 'mine.json', mimeType: 'application/json', buffer: Buffer.from('{"mine":1}') });
  await backup.getByRole('button', { name: 'Upload' }).click();
  await expect(backup.locator('output')).toHaveText('Uploaded: 10');
  const download = page.waitForEvent('download');
  await backup.getByRole('button', { name: 'Download' }).click();
  const d = await download;
  expect(d.suggestedFilename()).toBe('backup.json');  // Chrome adds the type's extension
  expect(readFileSync(await d.path(), 'utf8')).toBe('{"mine":1}');
});

// Below a remote node, files go in WebSocket envelopes: a gateway relaying
// an HTTP transfer serves nothing else meanwhile (TesserAPI §14). The demo's
// heliostat-3 is a peer behind TesserAPI's real relay; its log spans two
// download chunks.
test('files below a remote node, relayed in WebSocket envelopes', async ({ page }) => {
  const sent: { op: string; path: string }[] = [];
  page.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      const m = JSON.parse(String(f.payload));
      if (m.op === 'upload' || m.op === 'download') sent.push(m);
    }),
  );
  await page.goto('/?api=http://localhost:8091/api#/peers/heliostat-3/diagnostics');
  await expect(page.locator('.state')).toHaveText('Live');
  const log = page.locator('.row', { has: page.locator('label span:text-is("Log")') });
  const fetch = async () => {
    const download = page.waitForEvent('download');
    await log.getByRole('button', { name: 'Download' }).click();
    return readFileSync(await (await download).path(), 'utf8');
  };
  const first = await fetch();
  expect(first.startsWith('tracking: azimuth 0\n')).toBe(true);
  expect(first.split('\n')).toHaveLength(201);

  const text = 'moved by hand\n'.repeat(500);
  await log.locator('input[type=file]').setInputFiles({ name: 'log.txt', mimeType: 'text/plain', buffer: Buffer.from(text) });
  await log.getByRole('button', { name: 'Upload' }).click();
  await expect(log.locator('output')).toHaveText(`Uploaded: ${text.length}`);
  expect(await fetch()).toBe(text);
  expect(new Set(sent.map((m) => `${m.op} ${m.path}`))).toEqual(new Set(['download /peers/heliostat-3/diagnostics/log', 'upload /peers/heliostat-3/diagnostics/log']));
});

// With HTTP only, it goes over HTTP, which the gateway relays too.
test('files below a remote node over HTTP only', async ({ page }) => {
  await page.goto('/?api=http://localhost:8091/api&ws=#/peers/heliostat-3/diagnostics');
  await expect(page.locator('.state')).toHaveText('Polling');
  const log = page.locator('.row', { has: page.locator('label span:text-is("Log")') });
  const download = page.waitForEvent('download');
  await log.getByRole('button', { name: 'Download' }).click();
  expect(readFileSync(await (await download).path(), 'utf8')).toMatch(/^(tracking: azimuth \d+\n|moved by hand\n)+$/);
});

// File nodes in a list's elements: TesserKIT's file browser
// (/sys/files/entries), faked over HTTP.
const schema = {
  type: 'object',
  children: {
    files: {
      type: 'object',
      children: {
        entries: {
          type: 'list',
          key: 'name',
          items: {
            type: 'object',
            children: {
              name: { type: 'string' },
              size: { type: 'integer', unit: 'B' },
              isDir: { type: 'boolean', ui: { icon: 'folder' } },
              content: { type: 'file', readable: true, writable: true, ui: { visibleWhen: 'isDir=false' } },
              open: { type: 'action', ui: { visibleWhen: 'isDir=true' } },
            },
          },
        },
      },
    },
  },
};
const values = {
  files: {
    entries: [
      { name: 'notes 1.txt', size: 2048, isDir: false },
      { name: 'logs', size: 0, isDir: true },
    ],
  },
};

test('file nodes in list elements, and uploads naming their file', async ({ page }) => {
  const puts: { url: string; body: string }[] = [];
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': 'Content-Disposition' };
  await page.route('http://files.test/api/**', async (route: Route) => {
    const r = route.request();
    const url = new URL(r.url());
    const path = url.pathname.slice('/api'.length);
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (r.method() === 'PUT') {
      puts.push({ url: r.url(), body: r.postData() ?? '' });
      return route.fulfill({ headers: cors, contentType: 'application/json', body: 'null' });
    }
    if (path.endsWith('/content')) {
      return route.fulfill({ headers: { ...cors, 'Content-Disposition': 'attachment; filename="notes 1.txt"' }, contentType: 'text/plain', body: 'hello' });
    }
    const view = url.searchParams.get('view');
    let body: unknown = view === 'hash' ? 'h1' : view === 'schema' ? schema : values;
    for (const name of path.split('/').filter(Boolean)) {
      body = view === 'schema' ? (body as typeof schema).children[name as 'files'] : (body as Record<string, unknown>)[name];
    }
    return route.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/?api=http://files.test/api&ws=#/');

  const line = (name: string) => page.locator('.item', { has: page.locator(`.name:text-is("${name}")`) });
  const notes = line('notes 1.txt');
  await expect(notes.locator('.sum')).toHaveText('2.0 KB');
  // A read-only list: no add or remove, but its files' buttons; a folder,
  // marked, has none (visibleWhen within the element).
  await expect(page.getByRole('button', { name: /^Add/ })).toHaveCount(0);
  await expect(notes.getByRole('button', { name: 'Download Content notes 1.txt' })).toBeVisible();
  await expect(notes.locator('.mark .icon')).toHaveCount(0);
  await expect(line('logs').locator('.mark .icon')).toHaveCount(1);
  await expect(line('logs').getByRole('button', { name: /Download/ })).toHaveCount(0);

  // Choosing a file on the line uploads it at once, by key, naming it.
  await notes.getByLabel('Upload Content notes 1.txt').setInputFiles({ name: 'new data.json', mimeType: 'application/json', buffer: Buffer.from('{"a":1}') });
  await expect(page.locator('.toast[data-kind=ok]')).toHaveText('Content notes 1.txt: Uploaded');
  expect(puts).toEqual([{ url: 'http://files.test/api/files/entries/notes%201.txt/content?filename=new%20data.json', body: '{"a":1}' }]);

  const download = page.waitForEvent('download');
  await notes.getByRole('button', { name: 'Download Content notes 1.txt' }).click();
  expect((await download).suggestedFilename()).toBe('notes 1.txt');

  // The element's own controls: the full file widget, and the folder's action.
  await notes.locator('.head').click();
  await notes.locator('.detail input[type=file]').setInputFiles({ name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('b') });
  await notes.locator('.detail').getByRole('button', { name: 'Upload' }).click();
  await expect(notes.locator('.detail .file output')).toHaveText('Uploaded');
  expect(puts[1].url).toBe('http://files.test/api/files/entries/notes%201.txt/content?filename=b.txt');
  await line('logs').locator('.head').click();
  await expect(line('logs').locator('.detail').getByRole('button', { name: 'Open' })).toBeVisible();
});
