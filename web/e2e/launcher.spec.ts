import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// The launcher (DESIGN.md §9.7): the bundle on a page that no node served,
// as on GitHub Pages. USB and Bluetooth are faked in the page, relaying the
// lines to the demo device's WebSocket, cut into small pieces with log
// output in between, as a UART or BLE indications would deliver them.

// Chrome counts a page fulfilled by Playwright as public, and its Local
// Network Access checks would then block the device on localhost.
test.use({ launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks'] } });

const menu = (page: Page) => page.locator('nav.side');
const row = (page: Page, label: string) => page.locator('.row', { has: page.locator(`label span:text-is("${label}")`) });
// A page served from a public origin: the launcher's files from dist/.
const serve = (page: Page, origin: string, html?: string) =>
  page.route(`${origin}/**`, (route) => {
    const file = new URL(route.request().url()).pathname.slice(1);
    if (file.endsWith('.js')) route.fulfill({ body: readFileSync(new URL(`../dist/${file}`, import.meta.url)), contentType: 'text/javascript' });
    else route.fulfill({ body: html ?? readFileSync(new URL('../dist/index.html', import.meta.url)), contentType: 'text/html' });
  });

// DESIGN.md §9.7.2: the workspace remembers its connections.
test('connects by address, and opens it again on the next visit', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h2')).toHaveText('Connect to a node');
  await page.getByLabel('Address').fill('localhost:8091');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('.state')).toHaveText('Live');
  await expect(page.locator('.brand')).toHaveText('TesserUI demo');
  await page.reload();
  await expect(page.locator('.state')).toHaveText('Live');
  await expect(page.locator('.brand')).toHaveText('TesserUI demo');
  // Closed: forgotten.
  await page.getByRole('button', { name: 'Close this connection' }).click();
  await expect(page.locator('h2')).toHaveText('Connect to a node');
  await page.reload();
  await expect(page.locator('h2')).toHaveText('Connect to a node');
});

// Each connection's nodes are tabs, one per device: the second node's peers
// are the first's (the same stub ids), so only its own tab is new. Apply to
// all reaches across connections.
test('several nodes at once: their tabs, one per device, apply to all across them', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Address').fill('localhost:8091');
  await page.getByRole('button', { name: 'Connect' }).click();
  const tabs = page.locator('nav.tabs').getByRole('link');
  await expect(tabs).toHaveText(['TesserUI demo', 'Heliostat', 'kitchen-lamp', 'Porch lamp'], { timeout: 10000 });
  await page.getByRole('button', { name: 'Another node' }).click();
  await expect(page.locator('h2')).toHaveText('Connect to a node');
  // Another fresh demo node (the test device gives each connection its own).
  await page.getByLabel('Address').fill('127.0.0.1:8091');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(tabs).toHaveText(['TesserUI demo', 'Heliostat', 'kitchen-lamp', 'Porch lamp', 'TesserUI demo'], { timeout: 10000 });
  await expect(tabs.last()).toHaveAttribute('aria-current', 'page');

  await page.getByRole('button', { name: 'Apply to all' }).click();
  await menu(page).getByRole('link', { name: 'Lamp' }).click();
  const entry = row(page, 'Brightness').locator('input[type=number]');
  await entry.fill('100');
  await entry.press('Enter');
  await expect(tabs.first().locator('.mark')).toHaveClass(/done/);
  await expect(tabs.nth(3).locator('.mark')).toHaveClass(/done/);
  await expect(tabs.nth(1).locator('.mark')).toHaveClass(/absent/);
  await expect(page.locator('.toast[data-kind=warn]')).toHaveText(/Applied to 2 of 4 other nodes\. kitchen-lamp: offline/);
  // The first node took it.
  await tabs.first().click();
  await expect(tabs.first()).toHaveAttribute('aria-current', 'page');
  await expect(menu(page).locator('[aria-current=page]')).toHaveText('Status');
  await menu(page).getByRole('link', { name: 'Lamp' }).click();
  await expect(row(page, 'Brightness').locator('input[type=number]')).toHaveValue('100');

  // Both open again on the next visit.
  await page.reload();
  await expect(tabs).toHaveCount(5, { timeout: 10000 });
});

// On HTTPS, the WebSocket is only tried for loopback: anything else would be
// mixed content. The page is served from a public HTTPS origin here.
test('on HTTPS, reaches a loopback node live', async ({ page }) => {
  await serve(page, 'https://pages.tesserui.test');
  await page.goto('https://pages.tesserui.test/?api=http://localhost:8091/api');
  await expect(page.locator('.state')).toHaveText('Live');
});

// The bridge (../bridge) lists the nodes it found, and proxies them: live
// over its WebSocket, or polled over its HTTP.
test('the bridge lists the nodes it finds, and serves them live', async ({ page }) => {
  await page.goto('/?bridge=http://localhost:8766');
  await page.getByRole('button', { name: 'Look for the bridge' }).click();
  // Its nodes join as tabs.
  const node = page.locator('nav.tabs').getByRole('link', { name: 'TesserUI demo' });
  await node.click();
  await expect(page.locator('.state')).toHaveText('Live');
  await expect(page.locator('.brand')).toHaveText('TesserUI demo');
  await menu(page).getByRole('link', { name: 'Sensors' }).click();
  const temperature = page.locator('.row', { has: page.locator('label span:text-is("Temperature")') }).locator('output');
  const first = await temperature.textContent();
  await expect(temperature).not.toHaveText(first!, { timeout: 8000 });
});

// A node's own scripts run beside every saved node's token: only for the
// nodes the user added or opened, not for every node the bridge finds
// (DESIGN.md §9.8). Closing the shown connection doesn't show one.
test("a node the bridge found runs its scripts only once opened", async ({ page }) => {
  const scripts: string[] = [];
  page.on('request', (r) => r.url().endsWith('/ext/sun-dial.js') && scripts.push(r.url()));
  await page.goto('/?bridge=http://localhost:8766');
  await page.getByRole('button', { name: 'Look for the bridge' }).click();
  const found = page.locator('nav.tabs').getByRole('link', { name: 'TesserUI demo' });
  await expect(found).toBeVisible();
  await page.getByLabel('Address').fill('localhost:8091');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('.state')).toHaveText('Live');
  await page.locator('header').getByRole('button', { name: 'Close this connection' }).click();
  await expect(page.locator('h2')).toHaveText('Connect to a node');
  expect(scripts).toEqual([]);

  await found.click();
  await expect(page.locator('.state')).toHaveText('Live');
  await page.evaluate(() => (location.hash = '#/v/sky'));
  await expect(page.locator('x-sun-dial p')).toContainText('target 180° / 45°');
  expect(scripts).toEqual(['http://localhost:8766/n/localhost%3A8091/ext/sun-dial.js']);
});

test('through the bridge over HTTP too', async ({ page }) => {
  await page.goto(`/?api=${encodeURIComponent('http://localhost:8766/n/localhost:8091/api')}&ws=`);
  await expect(page.locator('.state')).toHaveText('Polling');
  await expect(page.locator('.brand')).toHaveText('TesserUI demo');
});

// A node's custom elements name their scripts from its root (/ext/...):
// behind the bridge, that is the node's folder of the proxy (DESIGN §9.8).
test("through the bridge, a node's custom elements load from it", async ({ page }) => {
  const scripts: string[] = [];
  page.on('request', (r) => r.url().endsWith('.js') && scripts.push(r.url()));
  await page.goto(`/?api=${encodeURIComponent('http://localhost:8766/n/localhost:8091/api')}#/v/sky`);
  await expect(page.locator('x-sun-dial p')).toContainText('target 180° / 45°');
  expect(scripts).toContain('http://localhost:8766/n/localhost:8091/ext/sun-dial.js');
});

test('the bridge serves the launcher, whose tabs are its nodes at once', async ({ page }) => {
  await page.goto('http://localhost:8766/');
  await expect(page.locator('nav.tabs').getByRole('link', { name: 'TesserUI demo' })).toBeVisible();
});

// Another project's launcher: a configuration of its own, still a launcher.
test('a page can be a launcher with its own title', async ({ page }) => {
  // ui.js loads launcher.js, next to it.
  await serve(page, 'https://pages.kit.test', '<!doctype html><body><script>window.TESSER={launcher:true,title:"TesserKIT"}</script><script src="ui.js"></script></body>');
  await page.goto('https://pages.kit.test/');
  await expect(page.locator('h2')).toHaveText('Connect to a node');
  await expect(page.locator('.brand')).toHaveText('TesserKIT');
  await expect(page).toHaveTitle('TesserKIT');
});

// A fake navigator.serial and navigator.bluetooth, relaying to the device.
// `window.calls` counts ports opened and choosers shown.
function fakeDevices() {
  const calls: Record<string, number> = ((window as unknown as { calls: object }).calls = {});
  const record = (what: string) => void (calls[what] = (calls[what] ?? 0) + 1);
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const connect = async () => {
    const ws = new WebSocket('ws://localhost:8091/ws');
    await new Promise((r) => (ws.onopen = r));
    return ws;
  };
  // Lines from the browser, as bytes in any pieces, sent as frames.
  const lineSink = (ws: WebSocket) => {
    let buf = '';
    return (bytes: Uint8Array) => {
      buf += dec.decode(bytes, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        ((window as unknown as { sent: string[] }).sent ??= []).push(line);
        ws.send(line);
      }
    };
  };
  // Frames from the device as lines cut into `size`-byte pieces, with log
  // output before them, some of it holding JSON that looks like a reply.
  const pieces = (text: string, size: number) => {
    const bytes = enc.encode(`I (42) app: log line\n\x1b[0;32mW (43) wifi: noise\x1b[0m\nI (44) app: sent ${text.replace(/"body":.*/, '"body":"log"}')}\n${text}\n`);
    const out: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
    return out;
  };

  const port = {
    readable: null as ReadableStream<Uint8Array> | null,
    writable: null as WritableStream<Uint8Array> | null,
    ws: null as WebSocket | null,
    async open() {
      record('opened');
      const ws = (this.ws = await connect());
      this.readable = new ReadableStream({
        start(c) {
          ws.onmessage = (e) => pieces(e.data, 7).forEach((p) => c.enqueue(p));
          ws.onclose = () => c.close();
        },
      });
      const sink = lineSink(ws);
      this.writable = new WritableStream({ write: (chunk) => sink(chunk) });
    },
    async close() {
      this.ws?.close();
    },
    // A CP2102's, as on an ESP32 devkit.
    getInfo: () => ({ usbVendorId: 0x10c4, usbProductId: 0xea60 }),
  };
  // A port given once is the page's from then on (getPorts); with `twin`,
  // so is another board of the same kind.
  let given = sessionStorage.getItem('port') === '1';
  const twin = { ...port };
  Object.defineProperty(navigator, 'serial', {
    value: {
      requestPort: async () => (record('chooser'), sessionStorage.setItem('port', '1'), (given = true), port),
      getPorts: async () => (given ? (sessionStorage.getItem('twin') ? [twin, port] : [port]) : []),
    },
  });

  const device = new EventTarget() as EventTarget & { gatt: object };
  let ws: WebSocket | null = null;
  const tx = Object.assign(new EventTarget(), { value: null as DataView | null, startNotifications: async () => tx });
  const rx = { writeValueWithResponse: async (_: Uint8Array) => {} };
  const service = { getCharacteristic: async (uuid: string) => (uuid.startsWith('6e400002') ? rx : tx) };
  device.gatt = {
    async connect() {
      ws = await connect();
      const sink = lineSink(ws);
      rx.writeValueWithResponse = async (chunk) => {
        // A long write carries at most 512 bytes.
        if (chunk.length > 512) throw new Error('too long');
        sink(chunk);
      };
      ws.onmessage = (e) => {
        for (const p of pieces(e.data, 20)) {
          tx.value = new DataView(p.buffer);
          tx.dispatchEvent(new Event('characteristicvaluechanged'));
        }
      };
      ws.onclose = () => device.dispatchEvent(new Event('gattserverdisconnected'));
      return { getPrimaryService: async () => service };
    },
    disconnect() {
      ws?.close();
    },
  };
  Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async () => device } });
}

for (const [way, button] of [
  ['USB', 'Choose a port'],
  ['Bluetooth', 'Choose a device'],
] as const) {
  test(`over ${way}: lines in pieces, among log output`, async ({ page }) => {
    await page.addInitScript(fakeDevices);
    await page.goto('/');
    await page.getByRole('button', { name: button }).click();
    await expect(page.locator('.state')).toHaveText(way);
    await expect(page.locator('.brand')).toHaveText('TesserUI demo');
    // Subscriptions work: a value the demo animates changes.
    await menu(page).getByRole('link', { name: 'Sensors' }).click();
    const temperature = page.locator('.row', { has: page.locator('label span:text-is("Temperature")') }).locator('output');
    const first = await temperature.textContent();
    await expect(temperature).not.toHaveText(first!, { timeout: 8000 });
  });
}

// DESIGN.md §9.4: ui.js on a page that waits for a line (not a launcher)
// loads its connection screen, and the links, from a chunk.
test('a page with serial: true connects over USB, its screen from a chunk', async ({ page }) => {
  await page.addInitScript(fakeDevices);
  const chunks: string[] = [];
  page.on('request', (r) => r.url().includes('/ui/') && chunks.push(new URL(r.url()).pathname.replace(/-.*/, '')));
  await serve(page, 'https://pages.line.test', '<!doctype html><body><script>window.TESSER={api:"/api",ws:null,serial:true}</script><script src="ui.js"></script></body>');
  // The demo's custom elements, which this origin hasn't.
  await page.route('https://pages.line.test/ext/**', (r) => r.fulfill({ body: '', contentType: 'text/javascript' }));
  await page.goto('https://pages.line.test/');
  await page.getByRole('button', { name: 'Choose a port' }).click();
  await expect(page.locator('.state')).toHaveText('USB');
  await expect(page.locator('.brand')).toHaveText('TesserUI demo');
  expect(chunks).toContain('/ui/connect');
  expect(chunks).not.toContain('/launcher.js');
});

// DESIGN.md §9.7.2: a remembered port is a tab on the next visit, opened
// only on a click (opening it resets the board), without the chooser when
// it is the only port of its kind this page was given.
const calls = (page: Page) => page.evaluate(() => (window as unknown as { calls: Record<string, number> }).calls);
for (const twin of [false, true]) {
  test(`a remembered USB port opens on a click${twin ? ', through the chooser beside a twin' : ''}`, async ({ page }) => {
    await page.addInitScript(fakeDevices);
    await page.goto('/');
    await page.getByRole('button', { name: 'Choose a port' }).click();
    await expect(page.locator('.state')).toHaveText('USB');
    await expect(page.locator('.brand')).toHaveText('TesserUI demo');
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem('tesserui:nodes')))!)).toEqual([
      { key: 'usb:4292:60000:0', usb: [4292, 60000], label: 'TesserUI demo' },
    ]);
    if (twin) await page.evaluate(() => sessionStorage.setItem('twin', '1'));
    await page.reload();
    const tab = page.locator('nav.tabs').getByRole('link', { name: 'TesserUI demo' });
    await expect(tab).toBeVisible();
    await expect(page.locator('h2')).toHaveText('Connect to a node');
    await page.waitForTimeout(500);
    expect(await calls(page)).toEqual({});
    await tab.click();
    await expect(page.locator('.state')).toHaveText('USB');
    await expect(page.locator('.brand')).toHaveText('TesserUI demo');
    expect(await calls(page)).toEqual(twin ? { chooser: 1, opened: 1 } : { opened: 1 });
  });
}

// Lines present the token in an auth envelope (TesserAPI §10.4): the stored
// one after connecting, an empty one to sign out. A serial port's is its
// device's, by id (the demo has none), never another board's.
test('over USB, the token goes in an auth envelope', async ({ page }) => {
  await page.addInitScript(fakeDevices);
  await page.addInitScript(() => {
    localStorage.setItem('tesserui:token:serial:', 'demo-token');
    localStorage.setItem('tesserui:token:serial:246f28010203', 'another-board');
    // Every port's, as kept before: forgotten.
    localStorage.setItem('tesserui:token:serial', 'any-port');
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose a port' }).click();
  await expect(page.locator('.brand')).toHaveText('TesserUI demo');
  const auths = () =>
    page.evaluate(() => (window as unknown as { sent: string[] }).sent.filter((l) => l.includes('"op":"auth"')).map((l) => JSON.parse(l).token));
  expect(await auths()).toEqual(['demo-token']);
  expect(await page.evaluate(() => localStorage.getItem('tesserui:token:serial'))).toBeNull();
  await page.locator('header').getByRole('button', { name: 'Sign out' }).click();
  await expect.poll(auths).toEqual(['demo-token', '']);
  await expect(page.locator('.brand')).toHaveText('TesserUI demo');
});

// Files over a line move in download and upload envelopes (TesserAPI
// §10.1.1), chunk by chunk, through the demo node's own FileSession: the
// backup spans two download chunks, the upload three.
for (const [way, button] of [
  ['USB', 'Choose a port'],
  ['Bluetooth', 'Choose a device'],
] as const) {
  test(`over ${way}: files in envelopes`, async ({ page }) => {
    await page.addInitScript(fakeDevices);
    await page.goto('/');
    await page.getByRole('button', { name: button }).click();
    await menu(page).getByRole('link', { name: 'System' }).click();
    const backup = page.locator('.row', { has: page.locator('label span:text-is("Backup")') });
    const fetch = async () => {
      const download = page.waitForEvent('download');
      await backup.getByRole('button', { name: 'Download' }).click();
      const d = await download;
      return { name: d.suggestedFilename(), bytes: readFileSync(await d.path()) };
    };
    const first = await fetch();
    expect(first.name).toBe('backup.json');  // the device's name; Chrome adds the extension
    expect(first.bytes.toString()).toMatch(/^\{"entries":\["entry 0",.*,"entry 399"\]\}$/);

    const bytes = Buffer.from(Array.from({ length: 7000 }, (_, i) => (i * 37) & 0xff));
    await backup.locator('input[type=file]').setInputFiles({ name: 'mine.bin', mimeType: 'application/octet-stream', buffer: bytes });
    await backup.getByRole('button', { name: 'Upload' }).click();
    await expect(backup.locator('output')).toHaveText('Uploaded: 7000');
    const uploads = await page.evaluate(() =>
      (window as unknown as { sent: string[] }).sent.filter((l) => l.includes('"op":"upload"')).map((l) => JSON.parse(l)),
    );
    expect(uploads[0]).toMatchObject({ path: '/system/backup', size: 7000, filename: 'mine.bin' });
    expect(uploads.slice(1).map((u) => u.offset)).toEqual([0, 2880, 5760]);
    // The demo node lists crc32: every chunk carries its own, and every
    // download asks for them.
    expect(uploads.slice(1).every((u) => typeof u.crc32 === 'number')).toBe(true);
    const downloads = await page.evaluate(() => (window as unknown as { sent: string[] }).sent.filter((l) => l.includes('"op":"download"')).map((l) => JSON.parse(l)));
    expect(downloads.every((d) => d.crc32 === true)).toBe(true);
    expect((await fetch()).bytes.equals(bytes)).toBe(true);
  });
}

// Installing firmware (DESIGN.md §9.7.1): a launcher configured with
// `firmware` offers it over USB, and loads the flasher, flash.js, only then.
// The releases come from the site's manifest (scripts/firmware.mjs); writing
// one needs a board's bootloader, which is checked on hardware.
test('a launcher with firmware offers to install it, from its releases', async ({ page }) => {
  const firmware = {
    images: [
      { label: 'Full', asset: 'kit-full-{target}-factory.bin', description: 'Every service.' },
      { label: 'Gateway', asset: 'gateway-{target}-factory.bin' },
    ],
    wifi: '/sys/network/wifi',
  };
  const manifest = {
    repo: 'leokeba/TesserKIT',
    releases: [
      { tag: 'v0.1.12', date: '2026-10-13T12:00:00Z', assets: [{ name: 'kit-full-esp32-factory.bin', size: 1 }] },
      {
        tag: 'v0.1.11',
        date: '2026-10-12T12:00:00Z',
        assets: [
          { name: 'kit-full-esp32-factory.bin', size: 1 },
          { name: 'gateway-esp32c3-factory.bin', size: 1 },
        ],
      },
    ],
  };
  const scripts: string[] = [];
  page.on('request', (r) => scripts.push(new URL(r.url()).pathname));
  await page.route('**/kit.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><body><script>window.TESSER=${JSON.stringify({ launcher: true, title: 'TesserKIT', firmware })}</script><script src="ui.js"></script></body>`,
    }),
  );
  await page.route('**/firmware/manifest.json', (route) => route.fulfill({ json: manifest }));
  await page.addInitScript(fakeDevices);
  await page.goto('/kit.html');
  await expect(page.locator('h2')).toHaveText('Connect to a node');
  expect(scripts).not.toContain('/flash/flash.js');

  await page.getByRole('button', { name: 'Install firmware' }).click();
  const firmwareSelect = page.getByLabel('Firmware');
  const version = page.getByLabel('Version');
  await expect(firmwareSelect.locator('option')).toHaveText(['Full', 'Gateway', 'A file on this computer']);
  await expect(page.getByText('Every service.')).toBeVisible();
  await expect(version.locator('option')).toHaveText([/^v0\.1\.12 · /, /^v0\.1\.11 · /]);
  expect(scripts).toContain('/flash/flash.js');

  // Only the releases with the chosen firmware.
  await firmwareSelect.selectOption('Gateway');
  await expect(version.locator('option')).toHaveText([/^v0\.1\.11 · /]);
  await expect(page.getByRole('button', { name: 'Choose a port and install' })).toBeEnabled();

  // Or a file, once chosen.
  await firmwareSelect.selectOption('A file on this computer');
  const install = page.getByRole('button', { name: 'Choose a port and install' });
  await expect(install).toBeDisabled();
  await page.getByLabel('File', { exact: true }).setInputFiles({ name: 'mine.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(16) });
  await expect(install).toBeEnabled();
});

test('a launcher without firmware offers no install', async ({ page }) => {
  await page.addInitScript(fakeDevices);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Choose a port' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Install firmware' })).toHaveCount(0);
});
