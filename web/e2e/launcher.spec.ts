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

test('connects by address, and lists the node afterwards', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h2')).toHaveText('Connect to a node');
  await page.getByLabel('Address').fill('localhost:8091');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page).toHaveURL(/\?api=http%3A%2F%2Flocalhost%3A8091%2Fapi/);
  await expect(page.locator('.state')).toHaveText('Live');
  await expect(page.locator('.brand')).toHaveText('TesserUI demo');

  await page.getByRole('link', { name: 'Another node' }).click();
  const recent = page.locator('a.recent');
  await expect(recent).toHaveText(/TesserUI demo\s*localhost:8091/);
  await recent.click();
  await expect(page.locator('.state')).toHaveText('Live');
});

// On HTTPS, the WebSocket is only tried for loopback: anything else would be
// mixed content. The page is served from a public HTTPS origin here.
test('on HTTPS, reaches a loopback node live', async ({ page }) => {
  const dist = new URL('../dist/', import.meta.url);
  await page.route('https://pages.tesserui.test/**', (route) => {
    const file = new URL(route.request().url()).pathname.endsWith('ui.js') ? 'ui.js' : 'index.html';
    route.fulfill({ body: readFileSync(new URL(file, dist)), contentType: file.endsWith('js') ? 'text/javascript' : 'text/html' });
  });
  await page.goto('https://pages.tesserui.test/?api=http://localhost:8091/api');
  await expect(page.locator('.state')).toHaveText('Live');
});

// The bridge (../bridge) lists the nodes it found, and proxies them: live
// over its WebSocket, or polled over its HTTP.
test('the bridge lists the nodes it finds, and serves them live', async ({ page }) => {
  await page.goto('/?bridge=http://localhost:8766');
  await page.getByRole('button', { name: 'Look for the bridge' }).click();
  const node = page.locator('a.recent', { hasText: 'TesserUI demo' });
  await expect(node).toContainText('localhost');
  await node.click();
  await expect(page.locator('.state')).toHaveText('Live');
  await expect(page.locator('.brand')).toHaveText('TesserUI demo');
  await menu(page).getByRole('link', { name: 'Sensors' }).click();
  const temperature = page.locator('.row', { has: page.locator('label span:text-is("Temperature")') }).locator('output');
  const first = await temperature.textContent();
  await expect(temperature).not.toHaveText(first!, { timeout: 8000 });

  // Listed among the recent nodes, behind the bridge.
  await page.getByRole('link', { name: 'Another node' }).click();
  await expect(page.locator('a.recent', { hasText: 'TesserUI demo' }).last()).toContainText('localhost:8091 · bridge');
});

test('through the bridge over HTTP too', async ({ page }) => {
  await page.goto(`/?api=${encodeURIComponent('http://localhost:8766/n/localhost:8091/api')}&ws=`);
  await expect(page.locator('.state')).toHaveText('Polling');
  await expect(page.locator('.brand')).toHaveText('TesserUI demo');
});

test('the bridge serves the launcher, which lists its nodes at once', async ({ page }) => {
  await page.goto('http://localhost:8766/');
  await expect(page.locator('a.recent', { hasText: 'TesserUI demo' })).toBeVisible();
});

// Another project's launcher: a configuration of its own, still a launcher.
test('a page can be a launcher with its own title', async ({ page }) => {
  const dist = new URL('../dist/', import.meta.url);
  await page.route('https://pages.kit.test/**', (route) => {
    const js = new URL(route.request().url()).pathname.endsWith('ui.js');
    route.fulfill(
      js
        ? { body: readFileSync(new URL('ui.js', dist)), contentType: 'text/javascript' }
        : { body: '<!doctype html><body><script>window.TESSER={launcher:true,title:"TesserKIT"}</script><script src="ui.js"></script></body>', contentType: 'text/html' },
    );
  });
  await page.goto('https://pages.kit.test/');
  await expect(page.locator('h2')).toHaveText('Connect to a node');
  await expect(page.locator('.brand')).toHaveText('TesserKIT');
  await expect(page).toHaveTitle('TesserKIT');
});

// A fake navigator.serial and navigator.bluetooth, relaying to the device.
function fakeDevices() {
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
  // output before them and on the same line.
  const pieces = (text: string, size: number) => {
    const bytes = enc.encode(`I (42) app: log line\n\x1b[0;32mW (43) wifi: noise ${text}\n`);
    const out: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
    return out;
  };

  const port = {
    readable: null as ReadableStream<Uint8Array> | null,
    writable: null as WritableStream<Uint8Array> | null,
    ws: null as WebSocket | null,
    async open() {
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
  };
  Object.defineProperty(navigator, 'serial', { value: { requestPort: async () => port } });

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

// Lines present the token in an auth envelope (TesserAPI §10.4): the stored
// one after connecting, an empty one to sign out.
test('over USB, the token goes in an auth envelope', async ({ page }) => {
  await page.addInitScript(fakeDevices);
  await page.addInitScript(() => localStorage.setItem('tesserui:token:serial', 'demo-token'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Choose a port' }).click();
  await expect(page.locator('.brand')).toHaveText('TesserUI demo');
  const auths = () =>
    page.evaluate(() => (window as unknown as { sent: string[] }).sent.filter((l) => l.includes('"op":"auth"')).map((l) => JSON.parse(l).token));
  expect(await auths()).toEqual(['demo-token']);
  await page.locator('header').getByRole('button', { name: 'Sign out' }).click();
  await expect.poll(auths).toEqual(['demo-token', '']);
  await expect(page.locator('.brand')).toHaveText('TesserUI demo');
});
