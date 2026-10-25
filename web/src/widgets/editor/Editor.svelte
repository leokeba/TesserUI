<script lang="ts" module>
  // Unsaved text, by file: leaving the editor (another folder, back) keeps
  // it until the editor is closed or the file saved.
  const drafts = new Map<string, string>();
</script>

<script lang="ts">
  // A text file's editor (DESIGN.md §4.2): a file node's content, or a
  // file of a files widget's tree (`filename`), downloaded, edited and
  // uploaded whole. A chunk of its own.
  import { errorText } from '../../client/types';
  import Icon from '../../Icon.svelte';
  import { useSession } from '../../shared.svelte';
  import { transfer } from '../transfer';
  interface Stamp {
    size: number;
    modified: number;
  }
  let {
    path,
    filename,
    name,
    fresh = false,
    stamp,
    check,
    close,
  }: { path: string; filename?: string; name: string; fresh?: boolean; stamp?: Stamp; check?: () => Promise<Stamp | undefined>; close: () => void } = $props();
  const session = useSession();
  const t = (text: string, vars?: Record<string, string | number>) => session.t(text, vars);
  // svelte-ignore state_referenced_locally
  const key = path + (filename ?? '');
  // svelte-ignore state_referenced_locally
  let seen = stamp;
  // svelte-ignore state_referenced_locally
  let made = $state(!fresh);
  let text = $state('');
  let saved = $state('');
  let wrap = $state(false);
  let busy = $state(true);
  let error = $state('');
  // The device's copy changed and wasn't overwritten: Revert loads it.
  let stale = $state(false);
  let area: HTMLTextAreaElement | undefined = $state();
  let gutter: HTMLElement | undefined = $state();
  // svelte-ignore state_referenced_locally
  const json = /\.json$/i.test(name);
  const dirty = $derived(text !== saved);

  async function load() {
    busy = true;
    error = '';
    if (made) {
      const r = await transfer(session, path, null, () => {}, filename);
      if (r.status !== 'ok') return void ((error = errorText(r, t)), (busy = false));
      const b = r.body as Blob;
      if (b.size > 131072) return void ((error = t('Too large to edit here: download it.')), (busy = false));
      saved = await b.text();
      if (saved.includes('\0') && !confirm(t('Open as text anyway?'))) return close();
    }
    text = drafts.get(key) ?? saved;
    drafts.delete(key);
    busy = false;
  }
  load();
  $effect(() => () => dirty && drafts.set(key, text));

  async function save() {
    error = '';
    if (json) {
      try {
        JSON.parse(text);
      } catch (e) {
        const m = String(e);
        const at = /position (\d+)/.exec(m);
        return void (error = t('Not valid JSON, line {n}', { n: /line (\d+)/.exec(m)?.[1] ?? (at ? text.slice(0, +at[1]).split('\n').length : 1) }));
      }
    }
    // Last save wins, unless the device's copy changed since it was read.
    const now = made && check ? await check() : undefined;
    if (now && seen && (now.size !== seen.size || now.modified !== seen.modified) && !confirm(t('The file changed on the device. Overwrite it?'))) {
      seen = now;
      return void ((stale = true), (error = t('Not saved: the file changed on the device. Revert loads its copy.')));
    }
    busy = true;
    const r = await transfer(session, path, new File([text], name), () => {}, filename);
    busy = false;
    if (r.status !== 'ok') return void (error = errorText(r, t));
    saved = text;
    made = true;
    stale = false;
    seen = check && (await check());
  }

  // Tab indents the line or the lines selected by 2 spaces, Shift+Tab
  // takes them back; Ctrl or Cmd+S saves.
  function key_(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') return void (e.preventDefault(), save());
    const a = area!;
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const [s, end] = [a.selectionStart, a.selectionEnd];
    const from = text.lastIndexOf('\n', s - 1) + 1;
    if (!e.shiftKey && s === end) a.setRangeText('  ', s, end, 'end');
    else a.setRangeText(text.slice(from, end).split('\n').map((l) => (e.shiftKey ? l.replace(/^ {1,2}/, '') : '  ' + l)).join('\n'), from, end, 'select');
    text = a.value;
  }

  $effect(() => {
    const leave = (e: BeforeUnloadEvent) => dirty && e.preventDefault();
    addEventListener('beforeunload', leave);
    return () => removeEventListener('beforeunload', leave);
  });
</script>

<div class="editor">
  <div class="head">
    <strong>{name + (dirty ? ' •' : '')}</strong>
    <label><input type="checkbox" checked={wrap} onchange={() => (wrap = !wrap)} /> {t('Wrap')}</label>
    {#if json}<button type="button" disabled={busy} onclick={() => {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        save();
      }
    }}>{t('Format')}</button>{/if}
    <button type="button" disabled={busy || (!dirty && !stale)} onclick={() => (stale ? ((stale = false), load()) : (text = saved))}>{t('Revert')}</button>
    <button type="button" class="primary" disabled={busy || (!dirty && made)} onclick={save}>{t('Save')}</button>
    <button type="button" class="quiet" aria-label={t('Close')} title={t('Close')} onclick={() => (!dirty || confirm(t('Discard your changes?'))) && ((text = saved), close())}><Icon name="x" /></button>
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="body">
    {#if !wrap}<pre bind:this={gutter} aria-hidden="true">{text.split('\n').map((_, i) => i + 1).join('\n')}</pre>{/if}
    <textarea
      bind:this={area}
      value={text}
      oninput={(e) => (text = e.currentTarget.value)}
      class:wrap
      spellcheck="false"
      aria-label={name}
      disabled={busy}
      onkeydown={key_}
      onscroll={() => gutter && (gutter.scrollTop = area!.scrollTop)}
    ></textarea>
  </div>
</div>

<style>
  .editor {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    height: 70vh;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  strong {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 4px);
    font: 0.85em/1.5 ui-monospace, Menlo, Consolas, monospace;
  }
  pre {
    margin: 0;
    padding: 8px 6px;
    overflow: hidden;
    text-align: right;
    color: var(--muted);
    background: var(--surface-2);
    user-select: none;
  }
  textarea {
    flex: 1;
    height: auto;
    margin: 0;
    padding: 8px;
    border: 0;
    border-radius: 0;
    font: inherit;
    resize: none;
    white-space: pre;
    background: var(--surface);
  }
  textarea.wrap {
    white-space: pre-wrap;
  }
  @media (max-width: 640px) {
    .editor {
      position: fixed;
      inset: 0;
      z-index: 7;
      height: auto;
      padding: 8px;
      background: var(--surface);
    }
  }
</style>
