import { expect, test } from '@playwright/test';

const api = 'http://localhost:8091/api';

test('custom elements draw nodes and write through tesser', async ({ page }) => {
  await page.goto(`/?api=${api}#/v/sky`);
  const dial = page.locator('x-sun-dial');
  await expect(dial.locator('p')).toContainText('target 180° / 45°');
  // Due east, halfway up: azimuth 90°, elevation 45°.
  const box = (await dial.locator('svg').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2 + (box.width * 50) / 224, box.y + box.height / 2);
  await expect(dial.locator('p')).toContainText('target 90° / 45°');
  await dial.focus();
  await page.keyboard.press('ArrowUp');
  await expect(dial.locator('p')).toContainText('target 90° / 50°');
});

test('an element that cannot load falls back to the inferred widget', async ({ page }) => {
  await page.route('**/ext/sun-dial.js', (r) => r.abort());
  await page.goto(`/?api=${api}#/sky`);
  await expect(page.locator('main pre')).toContainText('"targetAz": 180');
});

// A page that embeds two UIs (DESIGN.md §9.9), served on the preview's origin.
// Chrome counts a page fulfilled by Playwright as public, and its Local
// Network Access checks would then block the device on localhost.
test.use({ launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks'] } });
const host = `<!doctype html><html><head><meta charset="utf-8"><title>Host</title></head><body>
<h1>Host page</h1><div id="a"></div><div id="b"></div>
<script type="module">
  import { mount, version } from '/tesserui.js';
  window.version = version;
  mount(document.getElementById('a'), { api: '${api}', path: '/lamp', routing: 'memory', header: false,
    theme: { accent: 'rgb(200, 0, 0)' } });
  mount(document.getElementById('b'), { api: '${api}', path: '/motor', routing: 'memory',
    strings: { Run: 'Lancer', Live: 'En direct' } });
</script></body></html>`;

test('UIs embed in a page that owns the URL', async ({ page }) => {
  await page.route('**/embed', (r) => r.fulfill({ contentType: 'text/html', body: host }));
  await page.goto('/embed#own-hash');
  const a = page.locator('#a .tesserui');
  const b = page.locator('#b .tesserui');
  await expect(a.locator('h1')).toHaveText('Lamp');
  await expect(a.locator('.row', { hasText: 'Brightness' })).toBeVisible();
  await expect(a.locator('header')).toHaveCount(0);
  await expect(a.getByText('Speed')).toHaveCount(0);
  await expect(b.locator('h1')).toHaveText('Motor');
  await expect(b.locator('.row', { hasText: 'Speed' })).toBeVisible();
  await expect(b.locator('header .state')).toHaveText('En direct');
  await expect(b.getByRole('button', { name: 'Lancer' })).toBeVisible();
  // The host keeps its URL and its own styles.
  await expect(page).toHaveURL(/#own-hash$/);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('h1')!).fontFamily)).not.toContain('system-ui');
  // The theme reaches its UI only.
  const accent = (sel: string) => page.evaluate((s) => getComputedStyle(document.querySelector(s)!).getPropertyValue('--accent').trim(), sel);
  expect(await accent('#a .tesserui')).toBe('rgb(200, 0, 0)');
  expect(await accent('#b .tesserui')).not.toBe('rgb(200, 0, 0)');
  expect(await page.evaluate(() => (window as unknown as { version: string }).version)).toMatch(/^\d+\.\d+\.\d+$/);
});

// A stub page (DESIGN.md §9.6) on one origin, ui.js from another: its chunk
// comes from beside ui.js, through CORS, since import() asks for it.
const stub = `<!doctype html><html><head><meta charset="utf-8"><title>Stub</title>
<script>window.TESSER={api:"${api}",ws:"ws://localhost:8091/ws"}</script></head>
<body><script src="http://localhost:8091/ui.js"></script></body></html>`;

test('a stub page loads the chunk from beside ui.js, on its origin', async ({ page }) => {
  await page.route('**/stub', (r) => r.fulfill({ contentType: 'text/html', body: stub }));
  const chunk = page.waitForResponse((r) => /^http:\/\/localhost:8091\/ui\/widgets-[\w-]+\.js$/.test(r.url()));
  await page.goto('/stub#/lamp');
  expect((await chunk).status()).toBe(200);
  await expect(page.locator('.row', { has: page.locator('label span:text-is("Power")') }).getByRole('meter')).toBeVisible();
});
