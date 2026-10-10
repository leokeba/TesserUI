<script lang="ts">
  // Files (DESIGN.md §4): downloaded with a GET, uploaded with the file as
  // a PUT's raw body, with progress. Over HTTP only, whatever the transport.
  import { parse } from '../client/json';
  import { errorText } from '../client/types';
  import { useSession } from '../shared.svelte';
  import type { WidgetProps } from './types';
  let { leaf, disabled, id }: WidgetProps = $props();
  const session = useSession();
  const t = (text: string, vars?: Record<string, string | number>) => session.t(text, vars);

  let file: File | null = $state(null);
  let progress: number | null = $state(null);
  let message = $state('');
  let failed = $state(false);
  const hint = (k: string) => (typeof leaf.schema.ui?.[k] === 'string' ? (leaf.schema.ui[k] as string) : undefined);
  const extensions: Record<string, string> = { 'application/json': '.json', 'text/plain': '.txt', 'text/csv': '.csv' };
  const accept = $derived(hint('accept') ?? (leaf.contentType !== 'application/octet-stream' ? leaf.contentType : undefined));

  function done(ok: boolean, text: string) {
    progress = null;
    failed = !ok;
    message = text;
  }

  function transfer(method: 'GET' | 'PUT', body?: File) {
    const x = new XMLHttpRequest();
    x.open(method, session.apiUrl(leaf.path));
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
      if (method === 'PUT') {
        file = null;
        return done(true, text && text !== 'null' && text.length < 300 ? `${t('Uploaded')}: ${text}` : t('Uploaded'));
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(x.response as Blob);
      a.download = hint('filename') ?? leaf.name + (extensions[leaf.contentType ?? ''] ?? '.bin');
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      done(true, '');
    };
    x.onerror = () => done(false, t('Transfer failed'));
    progress = 0;
    message = '';
    x.send(body ?? null);
  }

  function upload() {
    if (!file) return;
    if (leaf.maxSize && file.size > leaf.maxSize) return done(false, t('Too large: at most {n} bytes', { n: leaf.maxSize }));
    if (leaf.confirm && !confirm(leaf.confirm)) return;
    transfer('PUT', file);
  }
</script>

<div class="file">
  {#if session.kind === 'serial'}
    <span class="muted">{t('Files need a network connection')}</span>
  {:else}
    {#if leaf.readable}
      <button type="button" disabled={disabled || progress !== null} onclick={() => transfer('GET')}>{t('Download')}</button>
    {/if}
    {#if leaf.editable}
      <input {id} type="file" {accept} disabled={disabled || progress !== null} onchange={(e) => (file = e.currentTarget.files?.[0] ?? null)} />
      <button type="button" class={leaf.style ?? 'primary'} disabled={disabled || !file || progress !== null} onclick={upload}>{t('Upload')}</button>
    {/if}
    {#if progress !== null}<progress max="100" value={progress}></progress>{/if}
    {#if message}<output class:error={failed} role={failed ? 'alert' : undefined}>{message}</output>{/if}
  {/if}
</div>

<style>
  .file {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  input {
    flex: 1;
    min-width: 0;
  }
  progress,
  output {
    flex-basis: 100%;
  }
</style>
