import { expect, test, type Page } from '@playwright/test';

// The file browser and the editor (DESIGN.md §4.1, §4.2) on the demo's
// /files, in memory. Over HTTP only: files move over HTTP, and the isolated
// WebSocket nodes of the other tests would each have their own files.
const open = (page: Page, hash = '#/files') => page.goto(`/?api=http://localhost:8091/api&ws=${hash}`);
const rows = (page: Page) => page.locator('.files .list .row');

test('browses, uploads, edits, moves and deletes files, the folder in the route', async ({ page }) => {
  const answers: string[] = [];
  page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(answers.shift()) : d.accept()));
  await open(page);
  await expect(rows(page)).toHaveText([/^logs/, /^www/, /^readme\.txt.*23 B/, /^settings\.json/]);

  answers.push('img');
  await page.getByRole('button', { name: 'New folder' }).click();
  await expect(rows(page).first()).toHaveText(/^img/);
  await page.locator('.files input[type=file]').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello\n') });
  await expect(rows(page).filter({ hasText: 'note.txt' })).toHaveText(/6 B/);

  // A text file opens in the editor, its path in the route; reloading
  // reads it again.
  await page.getByRole('button', { name: 'readme.txt', exact: true }).click();
  await expect(page).toHaveURL(/#\/files\/~\/readme\.txt$/);
  const text = page.locator('.editor textarea');
  await expect(text).toHaveValue("The demo node's files.\n");
  await text.fill('Edited.\n');
  await expect(page.locator('.editor strong')).toHaveText('readme.txt •');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.editor strong')).toHaveText('readme.txt');
  await page.reload();
  await expect(text).toHaveValue('Edited.\n');
  // Another file straight from this one: an editor of its own, its unsaved
  // text kept for when it comes back.
  await text.fill('Edited twice.\n');
  await page.evaluate(() => (location.hash = '#/files/~/settings.json'));
  await expect(text).toHaveValue('{"lamp": true, "level": 3}\n');
  await expect(page.getByRole('button', { name: 'Format' })).toBeVisible();
  await page.goBack();
  await expect(text).toHaveValue('Edited twice.\n');
  await expect(page.locator('.editor strong')).toHaveText('readme.txt •');
  await page.getByRole('button', { name: 'Revert' }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page).toHaveURL(/#\/files\/~\/$/);

  // JSON: refused when invalid, with its line; formatted.
  await page.getByRole('button', { name: 'settings.json', exact: true }).click();
  await text.fill('{\n  "lamp": true,\n}');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.editor .error')).toHaveText(/line 3/);
  await text.fill('{"lamp": false}');
  await page.getByRole('button', { name: 'Format' }).click();
  await expect(text).toHaveValue('{\n  "lamp": false\n}');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.editor strong')).toHaveText('settings.json');
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // Moved into the new folder, which a link opens; the breadcrumb leads back.
  await page.getByRole('button', { name: 'Actions of note.txt' }).click();
  answers.push('/img/note.txt');
  await page.getByRole('button', { name: 'Move or rename' }).click();
  await expect(rows(page).filter({ hasText: 'note.txt' })).toHaveCount(0);
  await page.locator('.files .list').getByRole('link', { name: 'img' }).click();
  await expect(page).toHaveURL(/#\/files\/~\/img$/);
  await expect(page.locator('.files .crumbs a')).toHaveText(['', 'img']);
  await expect(page.locator('.files .crumbs a').first()).toHaveAccessibleName('Files');
  await expect(rows(page)).toHaveText([/^note\.txt/]);
  await page.getByRole('button', { name: 'Actions of note.txt' }).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.files .list')).toHaveText('Empty folder');
  await page.goBack();
  await expect(rows(page).first()).toHaveText(/^img/);
});

test('a file node of text opens in the editor', async ({ page }) => {
  await open(page, '#/system');
  await page.getByRole('button', { name: 'Edit' }).click();
  // What another test may have uploaded there.
  await expect(page.locator('.editor textarea')).toHaveValue(/^\{/);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.editor')).toHaveCount(0);
});

// DESIGN.md §4.2: a save checks the device's copy didn't change since it
// was read; declined, Revert loads it. Its own saves are no conflict.
test('the editor asks before overwriting a file another client changed', async ({ page }) => {
  let overwrite = false;
  page.on('dialog', (d) => (overwrite ? d.accept() : d.dismiss()));
  await open(page, '#/files/~/logs/boot.log');
  const text = page.locator('.editor textarea');
  await expect(text).toHaveValue('I (0) boot: started\n');
  await text.fill('mine\n');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.editor strong')).toHaveText('boot.log');
  await text.fill('mine again\n');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.editor strong')).toHaveText('boot.log');
  // Another client writes it.
  await page.evaluate(() => fetch('http://localhost:8091/api/files/file?filename=/logs/boot.log', { method: 'PUT', body: 'theirs, longer\n' }));
  await text.fill('mine, a third time\n');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.editor .error')).toHaveText(/Not saved/);
  await page.getByRole('button', { name: 'Revert' }).click();
  await expect(text).toHaveValue('theirs, longer\n');
  overwrite = true;
  await text.fill('mine at last\n');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.editor strong')).toHaveText('boot.log');
});
