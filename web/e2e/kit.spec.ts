import { expect, test, type Page } from '@playwright/test';

// What TesserKIT's services declare, against the demo tree's /system,
// /account, /settings and /sequence (test/trees.cpp).
const open = (page: Page, hash = '#/') => page.goto(`/?api=http://localhost:8091/api${hash}`);
const row = (page: Page, label: string) => page.locator('.row', { has: page.locator(`label span:text-is("${label}")`) });
const card = (page: Page, title: string) => page.locator('fieldset.card', { has: page.locator(`.title:text-is("${title}")`) });

test('flags, time zones, the browser clock and typed deferred actions', async ({ page }) => {
  await open(page);
  const days = row(page, 'Timer days');
  await expect(days.getByLabel('Mon')).toBeChecked();
  await expect(days.getByLabel('Sat')).not.toBeChecked();
  await days.getByLabel('Sat').check();
  await expect(days.getByLabel('Sat')).toBeChecked();

  // The POSIX string the device stores, derived from the IANA zone.
  const tz = row(page, 'Time zone').locator('select');
  await tz.selectOption('Asia/Tokyo');
  await expect(tz.locator('option').first()).toHaveText('<+09>-9');

  const before = Date.now();
  await page.getByRole('button', { name: 'Set from this device' }).click();
  const clock = row(page, 'Clock set to').locator('output');
  await expect(clock).not.toHaveText('0 ms');
  expect(Number((await clock.textContent())!.replace(/\D/g, ''))).toBeGreaterThanOrEqual(before);

  const scan = row(page, 'Scan');
  await scan.locator('input').fill('home');
  await scan.getByRole('button', { name: 'Run' }).click();
  await expect(scan.locator('output')).toHaveText('→ home-net');
});

test('secrets are never shown, and sign-in goes through the login action', async ({ page }) => {
  await open(page);
  const password = card(page, 'Settings').locator('input[type=password]');
  await expect(password).toHaveValue('');
  await expect(password).toHaveAttribute('placeholder', '••••••••');

  await page.locator('header').getByRole('button', { name: 'Sign in' }).click();
  const dialog = page.locator('dialog');
  await dialog.getByPlaceholder('Name').fill('admin');
  await dialog.getByPlaceholder('Password').fill('nope');
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  await expect(dialog.locator('.error')).toHaveText('wrong name or password');
  await dialog.getByPlaceholder('Password').fill('admin');
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('header').getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page.locator('.state')).toHaveText('Live');
  expect(await page.evaluate(() => localStorage.getItem('tesserui:token'))).toBe('demo-token');

  await page.locator('header').getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('header').getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('tesserui:token'))).toBeNull();

  // The login action's own fields, in its card, sign in too.
  const account = card(page, 'Account');
  await account.locator('input[type=text]').fill('admin');
  await account.locator('input[type=password]').fill('admin');
  await account.getByRole('button', { name: 'Login' }).click();
  await expect(page.locator('header').getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('arrays: edited whole, or plotted', async ({ page }) => {
  await open(page);
  const gains = row(page, 'Gains');
  await expect(gains.locator('tbody tr')).toHaveCount(3);
  await gains.getByRole('button', { name: 'Add' }).click();
  await expect(gains.locator('tbody tr')).toHaveCount(4);
  const cell = gains.locator('tbody tr').nth(1).locator('input[type=number]');
  await cell.fill('55');
  await cell.press('Enter');
  await expect(cell).toHaveValue('55');
  await cell.fill('500');
  await cell.press('Enter');
  await expect(page.locator('.error').first()).toContainText('range');
  await expect(row(page, 'Encoder offsets').locator('canvas')).toBeVisible();
});

test('custom elements: keyframes and the sky', async ({ page }) => {
  await open(page);
  const keyframes = page.locator('x-keyframes');
  const svg = keyframes.locator('svg');
  await expect(svg).toHaveAttribute('aria-label', 'Azimuth: 4 frames');
  await svg.scrollIntoViewIfNeeded();
  const box = (await svg.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.15);
  await expect(svg).toHaveAttribute('aria-label', 'Azimuth: 5 frames');
  await keyframes.getByRole('button', { name: 'Start' }).click();
  await expect(keyframes.locator('.info')).not.toHaveText('0.0 s', { timeout: 5000 });

  await open(page, '#/v/mirror');
  await expect(page.locator('x-sky p')).toContainText('mirror');
});
