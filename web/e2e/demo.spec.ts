import { expect, test, type Page } from '@playwright/test';

// Each WebSocket connection gets a fresh device, so every test starts from
// the demo tree's initial state.
const open = (page: Page, hash = '#/', query = '') => page.goto(`/?api=http://localhost:8091/api${query}${hash}`);
const row = (page: Page, label: string) => page.locator('.row', { has: page.locator(`label span:text-is("${label}")`) });
const card = (page: Page, title: string) => page.locator('fieldset.card', { has: page.locator(`.title:text-is("${title}")`) });

test('renders the tree, live', async ({ page }) => {
  await open(page);
  await expect(page.locator('.state')).toHaveText('Live');
  await expect(page.locator('.brand')).toHaveText('TesserUI demo');
  for (const t of ['Lamp', 'Motor', 'Sensors', 'Settings', 'Widget overrides', 'Nodes']) await expect(card(page, t)).toBeVisible();
  const uptime = row(page, 'Uptime').locator('output');
  const first = await uptime.textContent();
  await expect(uptime).not.toHaveText(first!, { timeout: 5000 });
});

test('writes are read back, and errors roll back', async ({ page }) => {
  await open(page);
  const lamp = card(page, 'Lamp');
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
  await open(page);
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

test('events toast', async ({ page }) => {
  await open(page);
  await expect(page.locator('.toast')).toContainText('Pressed', { timeout: 7000 });
  await expect(row(page, 'Pressed').locator('li').first()).toBeVisible();
});

test('conditions and forms', async ({ page }) => {
  await open(page);
  const config = card(page, 'Config');
  await expect(row(page, 'Manual speed')).toBeVisible();
  await config.getByRole('radio', { name: 'auto' }).click();
  await expect(row(page, 'Manual speed')).toHaveCount(0);
  await row(page, 'Enabled').locator('input[role=switch]').click();
  await expect(row(page, 'Threshold').locator('input')).toBeDisabled();

  const settings = card(page, 'Settings');
  await row(page, 'Ssid').locator('input').fill('field-net');
  await row(page, 'Ssid').locator('input').press('Enter');
  await expect(settings.locator('.form-actions span')).toHaveText('1 modified');
  await settings.getByRole('button', { name: 'Apply' }).click();
  await expect(settings.locator('.form-actions span')).toHaveCount(0);
  await expect(row(page, 'Ssid').locator('input')).toHaveValue('field-net');
});

test('warnings show while their condition holds', async ({ page }) => {
  await open(page);
  await page.locator('summary', { hasText: 'Network' }).click();
  const warning = row(page, 'Static address');
  await expect(warning).toHaveClass(/warning/);
  await expect(warning.locator('output')).toHaveText('Make sure no other device on the network uses this address.');
  await row(page, 'Dhcp').locator('input[role=switch]').click();
  await expect(warning).toHaveCount(0);
});

test('lists are edited as a whole', async ({ page }) => {
  await open(page);
  const schedule = row(page, 'Schedule');
  await expect(schedule.locator('tbody tr')).toHaveCount(2);
  // Runs is read-only: the rows written leave it out, or the device refuses them.
  await expect(schedule.locator('tbody tr').first().locator('td').nth(4)).toHaveText('12');
  await schedule.getByRole('button', { name: /Add/ }).click();
  await expect(schedule.locator('tbody tr')).toHaveCount(3);
  await schedule.getByRole('button', { name: 'Remove row 0' }).click();
  await expect(schedule.locator('tbody tr')).toHaveCount(2);
  await expect(schedule.locator('tbody tr').first().locator('input[type=text]')).toHaveValue('Evening');
  const label = schedule.getByRole('textbox', { name: 'Label 0' });
  await label.fill('Dusk');
  await label.press('Enter');
  await schedule.getByRole('button', { name: /Add/ }).click();
  await expect(schedule.locator('tbody tr')).toHaveCount(3);
  await expect(label).toHaveValue('Dusk');
  await expect(schedule.locator('.error')).toHaveCount(0);
});

test('views come first and combine peers', async ({ page }) => {
  await page.goto('/?api=http://localhost:8091/api');
  await expect(page).toHaveURL(/#\/v\/overview$/);
  await expect(page.getByText('Live values from')).toBeVisible();
  await expect(row(page, 'Porch lamp').locator('input[role=switch]')).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('/peers/kitchen-lamp/lamp/on: offline')).toBeVisible({ timeout: 10000 });
});

test('peer pages go through the gateway', async ({ page }) => {
  await open(page, '#/peers/heliostat-3');
  await expect(page.locator('h1')).toHaveText('Heliostat');
  await expect(card(page, 'Azimuth motor')).toBeVisible();
  await open(page, '#/peers/kitchen-lamp');
  await expect(page.getByText('This node is offline')).toBeVisible();
});

test('HTTP fallback polls', async ({ page }) => {
  await open(page, '#/', '&ws=');
  await expect(page.locator('.state')).toHaveText('Polling');
  await expect(card(page, 'Lamp')).toBeVisible();
  const uptime = row(page, 'Uptime').locator('output');
  const first = await uptime.textContent();
  await expect(uptime).not.toHaveText(first!, { timeout: 5000 });
});

test('phone width: no horizontal scroll, 44 px controls', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await open(page);
  await expect(card(page, 'Lamp')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  const small = await page.evaluate(
    () =>
      [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]), select, button')].filter(
        (e) => (e as HTMLElement).offsetParent && e.getBoundingClientRect().height < 43.5,
      ).length,
  );
  expect(small).toBe(0);
});
