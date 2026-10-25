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
  await expect(page.locator('.files .crumbs a')).toHaveText(['Files', 'img']);
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
