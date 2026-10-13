import { expect, test, type Page } from '@playwright/test';

// Each WebSocket connection gets a fresh device, so every test starts from
// the demo tree's initial state.
const open = (page: Page, hash = '#/', query = '') => page.goto(`/?api=http://localhost:8091/api${query}${hash}`);
const row = (page: Page, label: string) => page.locator('.row', { has: page.locator(`label span:text-is("${label}")`) });
const card = (page: Page, title: string) => page.locator('fieldset.card', { has: page.locator(`.title:text-is("${title}")`) });
const main = (page: Page) => page.locator('main');
// A value the demo animates, read on its page.
// The temperature is 21.5 + 1.5 sin(t / 20 s): at a peak or a trough its
// readout holds for about 10 s (the shared node's first peak is ~31 s in).
async function live(page: Page) {
  const temperature = row(page, 'Temperature').locator('output');
  const first = await temperature.textContent();
  await expect(temperature).not.toHaveText(first!, { timeout: 12000 });
}

test('renders the tree, live, one page per menu entry', async ({ page }) => {
  await open(page);
  await expect(page.locator('.state')).toHaveText('Live');
  await expect(page.locator('.brand')).toHaveText('TesserUI demo');
  const menu = page.locator('nav.side');
  for (const t of ['Overview', 'Status', 'Lamp', 'Motor', 'Sensors', 'Settings', 'Widget overrides', 'Nodes']) {
    await expect(menu.getByRole('link', { name: t, exact: true })).toBeVisible();
  }
  // The start page: the node's own values, not its objects.
  await expect(row(page, 'Uptime')).toBeVisible();
  await expect(row(page, 'Brightness')).toHaveCount(0);
  await menu.getByRole('link', { name: 'Sensors' }).click();
  await expect(page).toHaveURL(/#\/sensors$/);
  await expect(page.locator('h1')).toHaveText('Sensors');
  await expect(menu.locator('[aria-current=page]')).toHaveText('Sensors');
  await live(page);
  // Nodes lists its peers once open.
  await menu.getByRole('link', { name: 'Nodes' }).click();
  await expect(menu.getByRole('link', { name: 'Porch lamp' })).toBeVisible({ timeout: 10000 });
});

test('writes are read back, and errors roll back', async ({ page }) => {
  await open(page, '#/lamp');
  const lamp = main(page);
  // Power is computed by the device from on and brightness.
  await expect(row(page, 'Power').locator('output')).toHaveText('36 W');
  await row(page, 'On').locator('input[role=switch]').click();
  await expect(row(page, 'Power').locator('output')).toHaveText('0 W');
  await row(page, 'On').locator('input[role=switch]').click();
  const entry = row(page, 'Brightness').locator('input[type=number]');
  await entry.fill('100');
  await entry.press('Enter');
  await expect(row(page, 'Power').locator('output')).toHaveText('20 W');
  await entry.fill('300');
  await entry.press('Enter');
  await expect(lamp.locator('.error')).toHaveText('out of range');
  await expect(entry).toHaveValue('100');
});

test('actions: results, deferred calls, confirmations', async ({ page }) => {
  await open(page, '#/motor');
  const count = row(page, 'Count');
  await page.getByRole('button', { name: 'Count' }).click();
  await expect(page.locator('.action output').first()).toHaveText('→ 1');
  const home = page.getByRole('button', { name: /^Home/ });
  await home.click();
  await expect(home).toBeDisabled();
  await expect(home).toBeEnabled({ timeout: 5000 });
  page.once('dialog', (d) => d.accept());
  const move = row(page, 'Move to');
  await move.locator('input[type=number]').fill('90');
  await move.locator('input[type=number]').press('Enter');
  await move.getByRole('button', { name: 'Run' }).click();
  await expect(row(page, 'Position').locator('output').first()).toHaveText('90 °', { timeout: 5000 });
  void count;
});

test('keep-alives outlast dead-man timers, and stop with the control', async ({ page }) => {
  await open(page, '#/motor');
  // The jog stops unless called within a second: held, it's repeated.
  const jog = page.getByRole('button', { name: 'Jog' });
  const jogging = row(page, 'Jogging').locator('.led');
  const box = (await jog.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(jogging).toHaveAttribute('aria-label', 'On');
  await page.waitForTimeout(2500);
  await expect(jogging).toHaveAttribute('aria-label', 'On');
  await page.mouse.up();
  await expect(jogging).toHaveAttribute('aria-label', 'Off');

  // The drive falls back to 0 unless rewritten within a second: while it
  // isn't 0 and is on screen, the UI re-sends it.
  const drive = row(page, 'Drive').locator('input[type=number]');
  await drive.fill('0.5');
  await drive.press('Enter');
  await page.waitForTimeout(2500);
  await expect(drive).toHaveValue('0.50');
  // Back to 0 in one click, or by dragging close to the middle (a detent).
  await row(page, 'Drive').getByRole('button', { name: 'Set to 0' }).click();
  await expect(drive).toHaveValue('0.00');
  const slider = row(page, 'Drive').locator('input[type=range]');
  const s = (await slider.boundingBox())!;
  await page.mouse.move(s.x + s.width * 0.8, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width * 0.51, s.y + s.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(drive).toHaveValue('0.00');
  await expect(slider).toHaveValue('0');
  // Keys aren't snapped: the smallest step away from 0 stays.
  await slider.press('ArrowRight');
  await expect(drive).toHaveValue('0.01');
  await slider.press('ArrowLeft');
  await expect(drive).toHaveValue('0.00');
  await drive.fill('0.5');
  await drive.press('Enter');
  // Off screen, the device's timer stops it.
  await page.locator('nav.side').getByRole('link', { name: 'Lamp' }).click();
  await page.waitForTimeout(1600);
  await page.locator('nav.side').getByRole('link', { name: 'Motor' }).click();
  await expect(drive).toHaveValue('0.00');
});

test('events log on their page, and toast wherever the user is', async ({ page }) => {
  await open(page, '#/sensors');
  await expect(row(page, 'Pressed').locator('li').first()).toBeVisible({ timeout: 7000 });
  await expect(page.locator('.toast')).toHaveCount(0);
  // Homing ends with a hidden event marked ui.toast, seen from another page.
  await page.locator('nav.side').getByRole('link', { name: 'Motor' }).click();
  await page.getByRole('button', { name: /^Home/ }).click();
  await page.locator('nav.side').getByRole('link', { name: 'Lamp' }).click();
  const toast = page.locator('.toast[data-kind=ok]');
  await expect(toast).toHaveText(/Motor › Homed: at 0°/, { timeout: 5000 });
  await toast.getByRole('link', { name: 'Motor › Homed' }).click();
  await expect(page).toHaveURL(/#\/motor$/);
  await toast.getByRole('button', { name: 'Dismiss' }).click();
  await expect(toast).toHaveCount(0);
});

test('a log shows its lines oldest first, coloured by level, until cleared', async ({ page }) => {
  // The demo's /system/log: an ESP-IDF line every 3 s, the third a warning.
  await open(page, '#/system');
  const lines = page.getByRole('log').locator('div');
  await expect(lines).toHaveCount(3, { timeout: 11000 });
  await expect(lines.nth(0)).toHaveText(/^I \(\d+\) demo: tick$/);
  await expect(lines.nth(2)).toHaveText(/^W \(\d+\) mqtt: can't resolve the broker's name$/);
  await expect(lines.nth(2)).toHaveClass(/\bW\b/);
  // A long line scrolls sideways in the box, which stays in its card, with
  // the clear button in its top right corner.
  const box = (await page.getByRole('log').boundingBox())!;
  const clear = (await page.getByRole('button', { name: 'Clear' }).boundingBox())!;
  const sys = (await page.locator('fieldset.card', { has: page.getByRole('log') }).boundingBox())!;
  expect(await page.getByRole('log').evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  expect(box.x + box.width).toBeLessThanOrEqual(sys.x + sys.width);
  expect(clear.x + clear.width).toBeLessThanOrEqual(box.x + box.width);
  expect(clear.y).toBeLessThan(box.y + 10);
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByRole('log')).toHaveText('No events yet');
});

test('an error with no place on screen toasts, until a write there succeeds', async ({ page }) => {
  // The reply to the first write of /lamp/on is held, and comes back an
  // error once the page has changed.
  let release: (() => void) | undefined;
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m));
      if (!release && msg.op === 'set' && msg.path === '/lamp/on') {
        const body = { error: 'invalid_value', path: '/lamp/on', message: 'refused' };
        release = () => ws.send(JSON.stringify({ id: msg.id, status: 'invalid_value', body }));
      } else server.send(m);
    });
  });
  await open(page, '#/lamp');
  await row(page, 'On').locator('input[role=switch]').click();
  await page.locator('nav.side').getByRole('link', { name: 'Sensors' }).click();
  await expect(page.locator('h1')).toHaveText('Sensors');
  release!();
  const toast = page.locator('.toast[data-kind=error]');
  await expect(toast).toHaveText(/Lamp › On: refused/);
  await expect(toast).toHaveAttribute('role', 'alert');
  await toast.getByRole('link', { name: 'On' }).click();
  await expect(page.locator('h1')).toHaveText('Lamp');
  await expect(main(page).locator('.error')).toHaveCount(0);
  await row(page, 'On').locator('input[role=switch]').click();
  await expect(toast).toHaveCount(0);
});

test('conditions and forms', async ({ page }) => {
  await open(page, '#/config');
  const config = main(page);
  await expect(row(page, 'Manual speed')).toBeVisible();
  await config.getByRole('radio', { name: 'auto' }).click();
  await expect(row(page, 'Manual speed')).toHaveCount(0);
  await row(page, 'Enabled').locator('input[role=switch]').click();
  await expect(row(page, 'Threshold').locator('input')).toBeDisabled();

  await open(page, '#/settings');
  const settings = main(page);
  await row(page, 'Ssid').locator('input').fill('field-net');
  await row(page, 'Ssid').locator('input').press('Enter');
  await expect(settings.locator('.form-actions span')).toHaveText('1 modified');
  await settings.getByRole('button', { name: 'Apply' }).click();
  await expect(settings.locator('.form-actions span')).toHaveCount(0);
  await expect(row(page, 'Ssid').locator('input')).toHaveValue('field-net');
});

test("a select of a keyed list's keys", async ({ page }) => {
  await open(page, '#/widgets');
  const select = row(page, 'Source').locator('select');
  await expect(select.locator('option')).toHaveText(['Sun', 'Tower', 'Pool']);
  await expect(select).toHaveValue('Tower');
  await select.selectOption('Pool');
  await expect(select).toHaveValue('Pool');
  await expect(row(page, 'Source').locator('.busy')).toHaveCount(0);
});

// ui.options naming an object: its children, here the nodes under /peers,
// an offline one marked.
test('a select of the nodes under /peers', async ({ page }) => {
  await open(page, '#/widgets');
  const select = row(page, 'Node').locator('select');
  await expect(select.locator('option')).toHaveText(['Heliostat', 'kitchen-lamp (offline)', 'Porch lamp']);
  await expect(select).toHaveValue('porch-lamp');
  await select.selectOption('heliostat-3');
  await expect(row(page, 'Node').locator('.busy')).toHaveCount(0);
  await expect(select).toHaveValue('heliostat-3');
});

// ui.optionsValue: the same choice, storing a node's device id (TesserAPI
// 02c3bf4's "id" in a remote stub). The stored id is of a device not mounted.
test('a select of the nodes under /peers, by device id', async ({ page }) => {
  await open(page, '#/widgets');
  const select = row(page, 'Node id').locator('select');
  // Labelled from the peers' roots, which the node tabs read.
  await expect(select.locator('option')).toHaveText(['246f280a0b0c (not found)', 'Heliostat', 'kitchen-lamp (offline)', 'Porch lamp']);
  await select.selectOption('Porch lamp');
  await expect(row(page, 'Node id').locator('.busy')).toHaveCount(0);
  await expect(select).toHaveValue('246f28070809');
  await expect(select.locator('option')).toHaveText(['Heliostat', 'kitchen-lamp (offline)', 'Porch lamp']);
});

// ui.reorder: rows move up and down, the whole array written each time
// and read back.
test('an array whose rows move', async ({ page }) => {
  await open(page, '#/tables');
  const card = (title: string) => page.locator('.card', { has: page.locator('h2', { hasText: title }) });
  const table = card('Transport priority');
  const values = () => table.locator('tbody input').evaluateAll((e) => e.map((i) => (i as HTMLInputElement).value));
  await expect.poll(values).toEqual(['udp', 'nowtp', 'serial']);
  await expect(table.getByRole('button', { name: 'Move row 0 up' })).toBeDisabled();
  await expect(table.getByRole('button', { name: 'Move row 2 down' })).toBeDisabled();
  await table.getByRole('button', { name: 'Move row 0 down' }).click();
  await expect.poll(values).toEqual(['nowtp', 'udp', 'serial']);
  await table.getByRole('button', { name: 'Move row 2 up' }).click();
  await expect.poll(values).toEqual(['nowtp', 'serial', 'udp']);
  // A fixed-length array: no add or remove.
  await expect(table.getByRole('button', { name: /Remove|Add/ })).toHaveCount(0);
  // Other arrays don't move.
  await expect(card('Gains').locator('table')).toBeVisible();
  await expect(card('Gains').getByRole('button', { name: /Move/ })).toHaveCount(0);
});

test('groups load their schema on opening', async ({ page }) => {
  await open(page, '#/config');
  // Network is a collapsed card, Deep a heading, Deeper a group below the
  // page's schema depth: fetched when opened, then shown.
  await page.locator('summary', { hasText: 'Network' }).click();
  await page.locator('summary', { hasText: 'Deeper' }).click();
  await expect(row(page, 'Leaf').locator('input')).toHaveValue('42');
});

test('warnings show while their condition holds', async ({ page }) => {
  await open(page, '#/config');
  await page.locator('summary', { hasText: 'Network' }).click();
  const warning = row(page, 'Static address');
  await expect(warning).toHaveClass(/warning/);
  await expect(warning.locator('output')).toHaveText('Make sure no other device on the network uses this address.');
  await row(page, 'Dhcp').locator('input[role=switch]').click();
  await expect(warning).toHaveCount(0);
});

test('lists are edited element by element', async ({ page }) => {
  await open(page);
  // The start page also has the read-only Networks nearby list.
  const schedule = card(page, 'Schedule');
  const items = schedule.locator('.lv .item');
  await expect(items).toHaveCount(2);
  // An element opens into its own controls; Runs is read-only. Writes leave
  // it out, or the device would refuse them.
  await items.first().locator('.head').click();
  await expect(schedule.locator('.lv .detail output')).toHaveText(['12']);
  await items.first().locator('.head').click();
  await page.getByRole('button', { name: /Add/ }).click();
  await expect(items).toHaveCount(3);
  await page.getByRole('button', { name: 'Remove row 0' }).click();
  await expect(items).toHaveCount(2);
  await items.first().locator('.head').click();
  const label = page.getByRole('textbox', { name: 'Label', exact: true });
  await expect(label).toHaveValue('Evening');
  await label.fill('Dusk');
  await label.press('Enter');
  await page.getByRole('button', { name: /Add/ }).click();
  await expect(items).toHaveCount(3);
  await expect(label).toHaveValue('Dusk');
  await expect(schedule.locator('.lv .error')).toHaveCount(0);
});

test('views come first and combine peers', async ({ page }) => {
  await page.goto('/?api=http://localhost:8091/api');
  await expect(page).toHaveURL(/#\/v\/overview$/);
  await expect(page.getByText('Live values from')).toBeVisible();
  await expect(row(page, 'Porch lamp').locator('input[role=switch]')).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('/peers/kitchen-lamp/lamp/on: offline')).toBeVisible({ timeout: 10000 });
  // A wide card spans every column of the grid.
  const width = (sel: string) => page.locator(sel).first().evaluate((e) => e.getBoundingClientRect().width);
  await expect(page.locator('.card.wide h2')).toHaveText('Sequence');
  expect(await width('.card.wide')).toBe(await width('.grid'));
  expect(await width('.grid > .card:not(.wide)')).toBeLessThan((await width('.grid')) / 2);
});

test('peer pages go through the gateway', async ({ page }) => {
  // With the node tabs, a peer's root opens its first menu entry.
  await open(page, '#/peers/heliostat-3');
  await expect(page).toHaveURL(/#\/peers\/heliostat-3\/azimuth$/);
  await expect(page.locator('h1')).toHaveText('Azimuth motor');
  await expect(card(page, 'Control')).toBeVisible();
  await open(page, '#/peers/kitchen-lamp');
  await expect(page.getByText('This node is offline')).toBeVisible();
});

test('HTTP fallback polls', async ({ page }) => {
  await open(page, '#/sensors', '&ws=');
  await expect(page.locator('.state')).toHaveText('Polling');
  await live(page);
});

test('HTTP fallback streams the events', async ({ page }) => {
  await open(page, '#/sensors', '&ws=');
  await expect(page.locator('.state')).toHaveText('Polling');
  await expect(row(page, 'Pressed').locator('li').first()).toBeVisible({ timeout: 7000 });
  await page.locator('nav.side').getByRole('link', { name: 'Motor' }).click();
  await page.getByRole('button', { name: /^Home/ }).click();
  await page.locator('nav.side').getByRole('link', { name: 'Lamp' }).click();
  await expect(page.locator('.toast[data-kind=ok]')).toHaveText(/Motor › Homed: at 0°/, { timeout: 5000 });
});

test('phone width: no horizontal scroll, 44 px controls, the menu in a drawer', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await open(page, '#/lamp');
  await expect(row(page, 'Brightness')).toBeVisible();
  const menu = page.locator('nav.side');
  await expect(menu).not.toBeInViewport();
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(menu).toBeInViewport();
  await menu.getByRole('link', { name: 'Motor' }).click();
  await expect(page.locator('h1')).toHaveText('Motor');
  await expect(menu).not.toBeInViewport();
  await open(page, '#/lamp');
  await expect(row(page, 'Brightness')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  const small = await page.evaluate(
    () =>
      [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]), select, button')].filter(
        (e) => (e as HTMLElement).offsetParent && e.getBoundingClientRect().height < 43.5,
      ).length,
  );
  expect(small).toBe(0);
});

// A list the device fills (TesserAPI's ListNode::readOnly()) has no
// "writable" in its schema: its rows show, with nothing to add, remove or
// edit, and their actions still run. Elements with actions open into their
// own controls, since a table has no cell for an action.
test('a read-only list shows its rows, without editing', async ({ page }) => {
  await open(page, '#/networks');
  const list = main(page);
  await expect(list.getByRole('button', { name: /^Add/ })).toHaveCount(0);
  await expect(list.getByRole('button', { name: /Remove row/ })).toHaveCount(0);
  await list.getByRole('button', { name: /^home/ }).click();
  await expect(list.locator('.detail')).toContainText('-48');
  await expect(list.locator('.detail input:not([type=hidden])')).toHaveCount(0);
  await expect(list.locator('.detail').getByRole('button', { name: /join/i })).toBeEnabled();
});

// DESIGN.md §6.5: the node, then its remote nodes, as tabs; each opens that
// node's own menu, views first (the porch lamp's, read through the gateway).
test('nodes as tabs, each with its own menu and views', async ({ page }) => {
  await open(page);
  const tabs = page.locator('nav.tabs');
  await expect(tabs.getByRole('link')).toHaveText(['TesserUI demo', 'Heliostat', 'kitchen-lamp', 'Porch lamp'], { timeout: 10000 });
  await expect(tabs.getByRole('link', { name: 'kitchen-lamp' }).locator('.off')).toBeVisible();
  await tabs.getByRole('link', { name: 'Porch lamp' }).click();
  await expect(page).toHaveURL(/#\/peers\/porch-lamp\/_ui\/porch$/);
  await expect(tabs.locator('[aria-current=page]')).toHaveText('Porch lamp');
  const menu = page.locator('nav.side');
  await expect(menu.getByRole('link')).toHaveText(['Porch', 'Lamp', 'Sensors']);
  await expect(row(page, 'Brightness')).toBeVisible();
  await menu.getByRole('link', { name: 'Sensors' }).click();
  await expect(page).toHaveURL(/#\/peers\/porch-lamp\/sensors$/);
  await expect(row(page, 'Temperature')).toBeVisible();
  // Its pages are a node's: no way back above it.
  await expect(page.locator('.back')).toHaveCount(0);
  await tabs.getByRole('link', { name: 'Heliostat' }).click();
  await expect(menu.locator('[aria-current=page]')).toHaveText('Azimuth motor');
  // A tab opens its node's root: the device's status.
  await tabs.getByRole('link', { name: 'TesserUI demo' }).click();
  await expect(menu.locator('[aria-current=page]')).toHaveText('Status');
  await expect(row(page, 'Uptime')).toBeVisible();
  // Off: the device's menu again, its peers under Nodes; remembered.
  await page.getByRole('button', { name: 'Nodes as tabs' }).click();
  await expect(tabs).toHaveCount(0);
  await expect(page.locator('.brand')).toHaveText('TesserUI demo');
  await page.reload();
  await expect(page.locator('.state')).toHaveText('Live');
  await expect(page.getByRole('button', { name: 'Nodes as tabs' })).toHaveAttribute('aria-pressed', 'false');
  await expect(tabs).toHaveCount(0);
});
