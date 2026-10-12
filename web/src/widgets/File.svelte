<script lang="ts">
  // Files (DESIGN.md §4): downloaded with a GET, uploaded with the file as
  // a PUT's raw body, with progress; in envelopes on a client with no HTTP
  // (serial, Bluetooth). Compact (a list's line): icon buttons, a chosen
  // file uploads at once, and the outcome is a toast.
  import { download, upload as send } from '../client/files';
  import { fileUrl } from '../client/http';
  import { parse, stringify } from '../client/json';
  import { errorText } from '../client/types';
  import Icon from '../Icon.svelte';
  import { bytes } from '../model/format';
  import { useSession } from '../shared.svelte';
  import type { WidgetProps } from './types';
  let { leaf, disabled, id, compact = false }: WidgetProps & { compact?: boolean } = $props();
  const session = useSession();
  const t = (text: string, vars?: Record<string, string | number>) => session.t(text, vars);

  let file: File | null = $state(null);
  let progress: number | null = $state(null);
  let message = $state('');
  let failed = $state(false);
  const hint = (k: string) => (typeof leaf.schema.ui?.[k] === 'string' ? (leaf.schema.ui[k] as string) : undefined);
  const extensions: Record<string, string> = { 'application/json': '.json', 'text/plain': '.txt', 'text/csv': '.csv' };
  const accept = $derived(
    leaf.schema.accept ?? hint('accept') ?? (leaf.contentType !== 'application/octet-stream' ? leaf.contentType : undefined),
  );
  // Saves a download under the device's name (Content-Disposition, or the
  // envelope's filename), else one from the hints or the node's name.
  function save(blob: Blob, name = (blob as File).name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name || hint('filename') || leaf.name + (extensions[leaf.contentType ?? ''] ?? '.bin');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    done(true, '');
  }

  function uploaded(text: string) {
    file = null;
    done(true, text && text !== 'null' && text.length < 300 ? `${t('Uploaded')}: ${text}` : t('Uploaded'));
  }

  function done(ok: boolean, text: string) {
    progress = null;
    failed = !ok;
    message = text;
    if (compact && text) session.store.toasts.show(`${leaf.label}: ${text}`, ok ? 'ok' : 'error');
  }

  async function transfer(method: 'GET' | 'PUT', body?: File) {
    progress = 0;
    message = '';
    const client = session.fileClient();
    if (client) {
      const p = (f: number) => (progress = Math.round(f * 100));
      const r = body ? await send(client, leaf.path, body, p) : await download(client, leaf.path, p);
      if (r.status === 'unauthorized') session.store.onUnauthorized?.();
      if (r.status !== 'ok') return done(false, errorText(r, t));
      return body ? uploaded(stringify(r.body)) : save(r.body as File);
    }
    const x = new XMLHttpRequest();
    x.open(method, fileUrl(session.apiUrl(), leaf.path, body?.name));
    const token = session.token();
    if (token) x.setRequestHeader('Authorization', `Bearer ${token}`);
    if (method === 'GET') x.responseType = 'blob';
    (method === 'PUT' ? x.upload : x).onprogress = (e) => {
      if (e.lengthComputable) progress = Math.round((e.loaded / e.total) * 100);
    };
    x.onload = async () => {
      const text = method === 'GET' ? await (x.response as Blob).text() : x.responseText;
      if (x.status >= 300) {
        let reply: unknown = null;
        try {
          reply = parse(text);
        } catch {
          // not an error body
        }
        if (x.status === 403) session.store.onUnauthorized?.();
        return done(false, errorText({ status: `http_${x.status}`, body: reply }, t));
      }
      if (method === 'PUT') return uploaded(text);
      save(x.response as Blob, /filename="?([^";]+)"?/.exec(x.getResponseHeader('Content-Disposition') ?? '')?.[1]);
    };
    x.onerror = () => done(false, t('Transfer failed'));
    x.send(body ?? null);
  }

  function upload() {
    if (!file) return;
    if (leaf.maxSize && file.size > leaf.maxSize) return done(false, t('Too large: at most {n} bytes', { n: leaf.maxSize }));
    if (leaf.confirm && !confirm(leaf.confirm)) return;
    transfer('PUT', file);
  }
</script>

{#if compact}
  {#if progress !== null}<progress class="mini" max="100" value={progress}></progress>{/if}
  {#if leaf.readable}
    <button type="button" class="quiet" disabled={disabled || progress !== null} aria-label="{t('Download')} {leaf.label}" title={t('Download')} onclick={() => transfer('GET')}><Icon name="download" /></button>
  {/if}
  {#if leaf.editable}
    <input
      class="sr"
      {id}
      type="file"
      {accept}
      disabled={disabled || progress !== null}
      aria-label="{t('Upload')} {leaf.label}"
      onchange={(e) => {
        file = e.currentTarget.files?.[0] ?? null;
        e.currentTarget.value = '';
        upload();
      }}
    />
    <label for={id} class="up" class:off={disabled || progress !== null} title={t('Upload')}><Icon name="upload" /></label>
  {/if}
{:else}
<div class="file">
  {#if leaf.readable}
    <button type="button" disabled={disabled || progress !== null} onclick={() => transfer('GET')}><Icon name="download" /> {t('Download')}</button>
  {/if}
  {#if leaf.editable}
    <!-- The input is hidden; its label is the button. -->
    <input class="sr" {id} type="file" {accept} disabled={disabled || progress !== null} onchange={(e) => (file = e.currentTarget.files?.[0] ?? null)} />
    <label for={id} class="pick" class:off={disabled || progress !== null}>{file ? t('Change…') : t('Choose a file…')}</label>
    {#if file}
      <span class="name" title={file.name}>{file.name} <span class="muted">{bytes(file.size)}</span></span>
      <button type="button" class={leaf.style ?? 'primary'} disabled={disabled || progress !== null} onclick={upload}>{t('Upload')}</button>
    {/if}
  {/if}
  {#if progress !== null}<progress max="100" value={progress}></progress>{/if}
  {#if message}<output class:error={failed} role={failed ? 'alert' : undefined}>{message}</output>{/if}
</div>
{/if}

<style>
  .file {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
  }
  .pick {
    display: inline-flex;
    align-items: center;
    min-height: var(--control);
    padding: 0 12px;
    border: 1px dashed var(--muted);
    border-radius: calc(var(--radius) - 4px);
    cursor: pointer;
  }
  .pick:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .up {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: var(--control);
    min-height: var(--control);
    border-radius: calc(var(--radius) - 4px);
    cursor: pointer;
  }
  .up:hover {
    color: var(--accent);
  }
  .sr:focus-visible + .pick,
  .sr:focus-visible + .up {
    outline: 2px solid var(--accent);
  }
  .pick.off,
  .up.off {
    opacity: 0.5;
    pointer-events: none;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  progress {
    accent-color: var(--accent);
    height: 6px;
  }
  progress,
  output {
    flex-basis: 100%;
  }
  .mini {
    flex: none;
    width: 3em;
  }
</style>
