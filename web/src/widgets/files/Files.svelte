<script lang="ts">
  // A file browser (ui.widget "files", DESIGN.md §4.1) over its object's
  // actions: list, mkdir, move, delete, and its file node, addressed by
  // path. Where it is lives in the route (#/sys/files/~/www), so the
  // device keeps no state and every browser goes its own way. A chunk of
  // its own, as is the editor it opens.
  import { getContext, untrack } from 'svelte';
  import { errorText, type Notification } from '../../client/types';
  import Icon from '../../Icon.svelte';
  import { ICONS } from '../../icons';
  import { bytes, datetime } from '../../model/format';
  import { PLACE, useSession, type Place } from '../../shared.svelte';
  import { editor } from '../registry.svelte';
  import { save, transfer } from '../transfer';
  import type { WidgetProps } from '../types';
  import { ancestors, isImage, isText, join, nameOf, parentOf, sorted, type Entry } from './paths';
  let { leaf, disabled }: WidgetProps = $props();
  const session = useSession();
  const store = session.store;
  const t = (text: string, vars?: Record<string, string | number>) => session.t(text, vars);
  ICONS.file ??= 'M14 3H6v18h12V7zM14 3v4h4';
  ICONS.image ??= 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9h.01';

  // Outside a route (a view), it keeps its place itself.
  const place = getContext<Place | undefined>(PLACE);
  let own = $state('/');
  const at = $derived(place?.sub ?? own);
  const href = (p: string) => `#${leaf.path}/~${p}`;
  const go = (p: string) => (place ? place.go(href(p)) : (own = p));
  const node = (name: string) => `${leaf.path}/${name}`;

  // Folders' listings, the shown one's and the tree's.
  const kids: Record<string, Entry[]> = $state({});
  const unfolded: Record<string, boolean> = $state({ '/': true });
  let file: Entry | null = $state(null);
  let fresh = $state(false);
  async function list(p: string): Promise<boolean> {
    const r = await session.store.call(node('list'), p);
    if (r.status === 'ok') kids[p] = sorted((r.body as { entries?: Entry[] })?.entries ?? []);
    return r.status === 'ok';
  }
  const call = async (name: string, arg: unknown) => (await store.call(node(name), arg)).status === 'ok';

  // The route names a folder, or a file in one: the folder is listed,
  // and a file opens over it.
  const dir = $derived(at === '/' || kids[at] || !kids[parentOf(at)]?.some((e) => e.name === nameOf(at) && !e.dir) ? at : parentOf(at));
  $effect(() => {
    const p = at;
    untrack(async () => {
      // A new file isn't on the device yet.
      if (fresh) return void (file = { name: nameOf(p), size: 0, dir: false, modified: 0 });
      if (!kids[p] && !(await list(p)) && p !== '/') {
        delete store.errors[leaf.path];
        await list(parentOf(p));
      }
      // The tree, on a wide screen, unfolds down to it.
      if (matchMedia('(min-width: 800px)').matches) for (const a of ancestors(parentOf(p))) (unfolded[a] = true), kids[a] || list(a);
      const e = kids[parentOf(p)]?.find((e) => e.name === nameOf(p) && !e.dir);
      if (e !== file) file = e ?? null;
      if (file && !isText(file.name)) open(p, file, true);
    });
  });

  // Another client's change, or this one's: the folder that changed ("":
  // unknown, every folder shown).
  $effect(() => {
    const heard = (n: Notification) => n.path === node('changed') && typeof n.body === 'string' && Object.keys(kids).forEach((p) => (n.body || p) === p && list(p));
    session.heard.add(heard);
    return () => session.heard.delete(heard);
  });

  let progress: [string, number][] = $state([]);
  const fail = (text: string) => store.toasts.show(text, 'error', leaf.path);

  // Text opens in the editor (the route names it), an image in a preview,
  // anything else downloads.
  let image = $state('');
  async function open(p: string, e: Entry, direct = false) {
    if (isText(e.name) && !direct) return go(p);
    progress = [[e.name, 0]];
    const r = await transfer(session, node('file'), null, (f) => (progress = [[e.name, f]]), p);
    progress = [];
    if (r.status !== 'ok') return fail(errorText(r, t));
    if (isImage(e.name)) image = URL.createObjectURL(r.body as Blob);
    else save(r.body as Blob, e.name);
    if (direct && !isImage(e.name)) go(parentOf(p));
  }

  async function upload(files: FileList | null | undefined, into = dir) {
    for (const f of files ?? []) {
      if (kids[into]?.some((e) => e.name === f.name) && !confirm(t('Replace {name}?', { name: f.name }))) continue;
      progress = [...progress, [f.name, 0]];
      const r = await transfer(session, node('file'), f, (x) => (progress = progress.map((p) => (p[0] === f.name ? [p[0], x] : p))), join(into, f.name));
      if (r.status !== 'ok') fail(`${f.name}: ${errorText(r, t)}`);
      progress = progress.filter((p) => p[0] !== f.name);
    }
    list(into);
  }

  async function create(folder: boolean) {
    const name = prompt(t(folder ? 'New folder' : 'New file'))?.trim();
    if (!name) return;
    const p = join(dir, name);
    if (folder) return (await call('mkdir', p)) && list(dir);
    if (kids[dir]?.some((e) => e.name === name) && !confirm(t('Replace {name}?', { name }))) return;
    fresh = true;
    go(p);
  }

  let menu = $state('');
  async function act(e: Entry, what: string) {
    menu = '';
    const p = join(dir, e.name);
    if (what === 'move') {
      const to = prompt(t('Move or rename'), p)?.trim();
      if (to && to !== p && (await call('move', { from: p, to }))) list(dir), kids[parentOf(to)] && list(parentOf(to));
    } else if (what === 'delete') {
      if (confirm(t(e.dir ? 'Delete {name} and everything in it?' : 'Delete {name}?', { name: e.name })) && (await call('delete', p))) list(dir);
    } else if (what === 'edit') {
      if (isText(e.name) || confirm(t('Open as text anyway?'))) go(p);
    } else open(p, e, true);
  }

  const total = $derived(store.get(node('total')) as number | undefined);
  const used = $derived(store.get(node('used')) as number | undefined);
  // Files dropped on the listing, or on a folder of the tree.
  const over = (e: DragEvent) => e.preventDefault();
  const drop = (e: DragEvent, into = dir) => (e.preventDefault(), e.stopPropagation(), upload(e.dataTransfer?.files, into));
</script>

{#snippet tree(p: string)}
  {#each (kids[p] ?? []).filter((e) => e.dir) as e (e.name)}
    {@const q = join(p, e.name)}
    <div class="node" role="group" ondragover={over} ondrop={(e) => drop(e, q)}>
      <button type="button" class="quiet" class:up={unfolded[q]} aria-label={t('Sections of {label}', { label: e.name })} onclick={() => (unfolded[q] = !unfolded[q]) && !kids[q] && list(q)}><Icon name="down" /></button>
      <a href={href(q)} aria-current={dir === q ? 'page' : undefined}><Icon name="folder" />{e.name}</a>
    </div>
    {#if unfolded[q]}<div class="sub">{@render tree(q)}</div>{/if}
  {/each}
{/snippet}

<div class="files">
  <nav class="crumbs" aria-label={t('Folders')}>
    {#each ancestors(dir) as a (a)}<a href={href(a)} aria-current={a === dir ? 'page' : undefined} aria-label={a === '/' ? leaf.schema.label || '/' : undefined}>{#if a === '/'}<Icon name="home" />{:else}{nameOf(a)}{/if}</a>{/each}
  </nav>
  <div class="bar">
    <input id="{leaf.path}-up" class="sr" type="file" multiple {disabled} onchange={(e) => (upload(e.currentTarget.files), (e.currentTarget.value = ''))} />
    <label for="{leaf.path}-up" class="btn" class:off={disabled}><Icon name="upload" /> {t('Upload')}</label>
    <button type="button" {disabled} onclick={() => create(true)}><Icon name="plus" /> {t('New folder')}</button>
    <button type="button" {disabled} onclick={() => create(false)}><Icon name="edit" /> {t('New file')}</button>
    <button type="button" class="quiet" aria-label={t('Refresh')} title={t('Refresh')} onclick={() => list(dir)}><Icon name="refresh" /></button>
    {#if total}<meter min="0" max={total} value={used} title={t('{used} of {total}', { used: bytes(used ?? 0), total: bytes(total) })} aria-label={t('{used} of {total}', { used: bytes(used ?? 0), total: bytes(total) })}></meter>{/if}
  </div>
  {#each progress as [name, f] (name)}<div class="prog"><span>{name}</span><progress value={f}></progress></div>{/each}
  <div class="main">
    <nav class="tree" aria-label={t('Folders')} ondragover={over} ondrop={(e) => drop(e, '/')}>
      <a href={href('/')} aria-current={dir === '/' ? 'page' : undefined}><Icon name="folder" />/</a>
      {@render tree('/')}
    </nav>
    {#if file && (isText(file.name) || fresh)}
      {@const E = editor()}
      {@const p = join(dir, file.name)}
      <!-- An editor per file: one file's state never reaches another's. -->
      {#if E}{#key p}
        <E
          path={node('file')}
          filename={p}
          name={file.name}
          fresh={fresh}
          stamp={file}
          check={async () => ((await list(dir)) ? kids[dir].find((e) => e.name === file?.name) : undefined)}
          close={() => ((fresh = false), go(dir))}
        />
      {/key}{/if}
    {:else}
      <div class="list" role="list" ondragover={over} ondrop={drop}>
        {#each kids[dir] ?? [] as e (e.name)}
          {@const p = join(dir, e.name)}
          <div class="row">
            {#if e.dir}
              <a class="name" href={href(p)}><Icon name="folder" /><span>{e.name}</span></a>
            {:else}
              <button type="button" class="quiet name" onclick={() => open(p, e)}><Icon name={isImage(e.name) ? 'image' : 'file'} /><span>{e.name}</span></button>
              <span class="muted">{bytes(e.size)}</span>
            {/if}
            <span class="muted date">{datetime(e.modified)}</span>
            <button type="button" class="quiet" aria-label={t('Actions of {name}', { name: e.name })} aria-expanded={menu === e.name} onclick={() => (menu = menu === e.name ? '' : e.name)}><Icon name="more" /></button>
          </div>
          {#if menu === e.name}
            <div class="acts">
              {#if !e.dir}
                <button type="button" onclick={() => act(e, 'edit')}><Icon name="edit" /> {t('Edit')}</button>
                <button type="button" onclick={() => act(e, 'get')}><Icon name="download" /> {t('Download')}</button>
              {/if}
              <button type="button" {disabled} onclick={() => act(e, 'move')}>{t('Move or rename')}</button>
              <button type="button" class="danger" {disabled} onclick={() => act(e, 'delete')}><Icon name="trash" /> {t('Delete')}</button>
            </div>
          {/if}
        {:else}
          <p class="muted">{kids[dir] ? t('Empty folder') : t('Loading…')}</p>
        {/each}
      </div>
    {/if}
  </div>
  {#if image}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="preview" onclick={() => (URL.revokeObjectURL(image), (image = ''), go(dir))}><img src={image} alt={file?.name} /></div>
  {/if}
</div>

<style>
  .files {
    display: grid;
    gap: 8px;
    min-width: 0;
  }
  .crumbs,
  .bar,
  .row,
  .acts,
  .node,
  .prog {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .crumbs {
    overflow-x: auto;
    white-space: nowrap;
  }
  .crumbs a + a::before {
    content: '›';
    margin-right: 6px;
    color: var(--muted);
  }
  .crumbs [aria-current],
  .tree [aria-current] {
    color: var(--text);
    font-weight: 600;
  }
  .bar,
  .acts {
    flex-wrap: wrap;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: var(--control);
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 4px);
    cursor: pointer;
  }
  .off {
    opacity: 0.5;
    pointer-events: none;
  }
  .sr {
    position: absolute;
    opacity: 0;
    width: 1px;
  }
  meter {
    margin-left: auto;
  }
  .prog span {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .main {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  .tree {
    width: 200px;
    flex: none;
    overflow: auto;
  }
  .tree .sub {
    padding-left: 14px;
  }
  .tree a,
  .name {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: inherit;
    text-decoration: none;
  }
  .node button {
    padding: 0 4px;
    min-height: 30px;
    color: var(--muted);
  }
  .up :global(svg) {
    transform: rotate(180deg);
  }
  .list {
    flex: 1;
    min-width: 0;
    min-height: 120px;
  }
  .row {
    border-bottom: 1px solid var(--border);
    min-height: var(--control);
  }
  .name {
    flex: 1;
    justify-content: flex-start;
    padding: 0;
  }
  .name span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .date {
    font-size: 0.85em;
  }
  .acts {
    padding: 6px 0;
  }
  .preview {
    position: fixed;
    inset: 0;
    z-index: 7;
    display: grid;
    place-items: center;
    background: #000c;
  }
  .preview img {
    max-width: 95vw;
    max-height: 95vh;
  }
  @media (max-width: 800px) {
    .tree {
      display: none;
    }
    .date {
      display: none;
    }
  }
</style>
