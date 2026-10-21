<script lang="ts">
  // Lists and arrays (DESIGN.md §4). A table: one row per element, one column
  // per leaf; every edit writes the whole array, as TesserAPI replaces lists
  // (§4.4 there), and keyed lists match rows by key, so unread secrets
  // survive. A list (widget "list"): one line per element, which opens into
  // the element's own controls, each writing its own path; its file nodes
  // have buttons on its line. Elements edited as forms (ui.form) are added
  // through a draft, which a suggestion (ui.suggest) can fill.
  import { tick } from 'svelte';
  import { isObject, parse, stringify } from '../client/json';
  import { DEFERRED_TIMEOUT_MS } from '../client/types';
  import Icon from '../Icon.svelte';
  import Section from '../Section.svelte';
  import { holds } from '../model/conditions';
  import { formatValue, humanize } from '../model/format';
  import { buildLeaf, buildSection, visiblePaths, type Leaf } from '../model/model';
  import File from './File.svelte';
  import Secret from './Secret.svelte';
  import { useSession } from '../shared.svelte';
  import { parseNumber, type WidgetProps } from './types';
  let { leaf, value, set, disabled }: WidgetProps = $props();

  const session = useSession();
  const t = (text: string, vars?: Record<string, string | number>) => session.t(text, vars);
  const rows = $derived(Array.isArray(value) ? value : []);
  const cols = $derived(leaf.columns ?? []);
  const full = $derived(leaf.maxSize !== undefined && rows.length >= leaf.maxSize);
  // Rows can be added and removed: not for read-only or fixed-length arrays.
  const resizable = $derived(leaf.editable && !leaf.fixed);

  const copy = () => parse(stringify(rows)) as unknown[];
  // Left out of the rows written, the device keeps them (each row patches its
  // element): read-only fields, which it would refuse, and secrets, which read
  // as null. The key stays, as rows are matched by it.
  const omitted = $derived(cols.filter((c) => c.path && c.path !== leaf.key && (!c.editable || c.secret)));
  function strip(next: unknown[]) {
    for (const row of next) {
      for (const c of omitted) {
        const names = c.path.split('/');
        let o: unknown = row;
        for (const n of names.slice(0, -1)) o = isObject(o) ? o[n] : undefined;
        const last = names[names.length - 1];
        if (isObject(o) && (!c.editable || o[last] === null)) delete o[last];
      }
    }
    return next;
  }
  const send = (next: unknown[]) => set(strip(next));
  const cell = (row: unknown, col: Leaf): unknown => {
    if (!col.path) return row;
    let v = row;
    for (const s of col.path.split('/')) v = isObject(v) ? v[s] : undefined;
    return v;
  };

  function edit(i: number, col: Leaf, v: unknown) {
    const next = copy();
    if (!col.path) next[i] = v;
    else {
      const names = col.path.split('/');
      let o = next[i] as Record<string, unknown>;
      for (const n of names.slice(0, -1)) o = (o[n] ??= {}) as Record<string, unknown>;
      o[names[names.length - 1]] = v;
    }
    send(next);
  }
  // New elements start from their defaults: an empty patch, or, in a keyed
  // list, one naming its key. A scalar array's elements are checked against
  // their type (TesserAPI §4.5): the type's zero, within the range.
  let newKey = $state('');
  function scalar(c: Leaf): unknown {
    if (c.type === 'boolean') return false;
    if (c.type === 'string') return c.options?.[0]?.value ?? '';
    return Math.min(Math.max(0, c.min ?? -Infinity), c.max ?? Infinity);
  }
  function add() {
    if (form) return void begin({});
    send([...copy(), leaf.key ? { [leaf.key]: newKey } : cols.length === 1 && !cols[0].path ? scalar(cols[0]) : {}]);
    if (leaf.key) open = newKey;
    newKey = '';
  }
  const remove = (i: number) => send(copy().filter((_, j) => j !== i));
  function move(i: number, by: number) {
    const next = copy();
    [next[i], next[i + by]] = [next[i + by], next[i]];
    send(next);
  }

  // List lines: the element's name (its key, else its first value), up to
  // three short values, its first writable boolean as a switch, and its
  // files' buttons. A boolean with an icon marks the line while true (a
  // folder).
  // svelte-ignore state_referenced_locally
  const key = leaf.key;
  // svelte-ignore state_referenced_locally
  if (key) session.store.keys.set(leaf.path, key);
  const id = (row: unknown, i: number) => String(key && isObject(row) ? row[key] : i);
  let open: string | null = $state(null);
  const top = $derived(cols.filter((c) => !c.path.includes('/') && c.path !== key && !c.secret));
  const mark = $derived(top.find((c) => c.type === 'boolean' && c.icon));
  const flag = $derived(top.find((c) => c.type === 'boolean' && c.editable && c !== mark));
  const shown = $derived(top.filter((c) => c !== flag && c.type !== 'boolean').slice(0, 3));
  function text(v: unknown, c: Leaf): string {
    if (v === '' || v === undefined || v === null) return '';
    if (c.widget === 'flags') {
      const labels = (c.schema.ui?.labels as string | undefined)?.split(',') ?? [];
      return labels.filter((_, b) => (Number(v) >> b) & 1).join(' ');
    }
    return c.options?.find((o) => o.value === v)?.label ?? formatValue(v, c);
  }
  // An element's file node, with its conditions resolved within the element.
  const get = (p: string) => session.store.get(p);
  function fileOf(f: Leaf, path: string, k: string) {
    const l = buildLeaf(f.name, `${path}/${f.name}`, f.schema, path, session.nodeRoot(leaf.path), leaf.access);
    return { ...l, label: `${l.label} ${k}` };
  }
  // A new element edited as a form: a draft of its fields at a path no
  // element has, sent with the list once saved. Its key may name an element
  // already there: the draft patches it then.
  const form = $derived(leaf.schema.items?.ui?.form === true);
  // svelte-ignore state_referenced_locally
  const NEW = `${leaf.path}/+`;
  let fresh: { sec: ReturnType<typeof buildSection>; values: Record<string, unknown> } | null = $state.raw(null);
  let box: HTMLElement | undefined = $state();
  async function begin(values: Record<string, unknown>) {
    fresh = { sec: detail(NEW), values };
    await tick();
    // Focus: the first empty field; once a suggestion filled some, the first
    // empty secret (a network's password).
    const empty = cols.filter((c) => c.editable && !(`${NEW}/${c.path}` in values));
    const f = (empty.length < cols.length && empty.find((c) => c.secret)) || empty[0];
    if (f) box?.querySelector<HTMLElement>(`#t${`${NEW}/${f.path}`.replace(/[^\w-]/g, '_')}`)?.focus();
  }
  async function create(patch: Record<string, unknown> | null) {
    if (!patch) return void (fresh = null);
    const next = copy();
    const k = key ? patch[key] : undefined;
    const i = key ? next.findIndex((e) => isObject(e) && e[key] === k) : -1;
    if (i < 0) next.push(patch);
    else next[i] = patch;
    if ((await session.store.write(leaf.path, strip(next))).status !== 'ok') return;
    fresh = found = null;
    if (key) open = String(k);
  }

  // Suggestions (ui.suggest): the rows an action replies (a Wi-Fi scan's
  // networks), each a new element's draft with the fields of the same names.
  // svelte-ignore state_referenced_locally
  const via = leaf.suggest;
  let found: Record<string, unknown>[] | null = $state(null);
  let looking = $state(false);
  const named = $derived(cols.find((c) => c.path === key) ?? cols[0]);
  const saved = (k: unknown) => !!key && rows.some((e) => isObject(e) && e[key] === k);
  const dbm = (r: Record<string, unknown>) => (typeof r.rssi === 'number' ? `${r.rssi} dBm` : '');
  async function look() {
    looking = true;
    const r = await session.store.call(via!, null, session.schemaAt(via!)?.deferred ? DEFERRED_TIMEOUT_MS : undefined);
    looking = false;
    found = r.status === 'ok' && Array.isArray(r.body) ? r.body.filter((x) => isObject(x) && typeof cell(x, named) === 'string' && cell(x, named) !== '') : null;
  }
  function pick(r: Record<string, unknown>) {
    const k = cell(r, named);
    if (saved(k)) return void ((open = String(k)), (found = null));
    const values: Record<string, unknown> = {};
    for (const c of cols) {
      const v = cell(r, c);
      if (c.editable && v != null && typeof v !== 'object' && (c.type === 'string') === (typeof v === 'string')) values[`${NEW}/${c.path}`] = v;
    }
    begin(values);
  }

  // The element's controls, built when it opens; its paths are on screen,
  // so errors show on its fields.
  function detail(path: string) {
    const sec = { ...buildSection(path, leaf.schema.items!, 2, session.nodeRoot(leaf.path), leaf.access), label: '' };
    for (const p of visiblePaths({ cards: [sec] })) session.store.visible.add(p);
    return sec;
  }
</script>

<!-- Moving a row (ui.reorder): up, down. -->
{#snippet mover(i: number, k: string | number)}
  <span class="move">
    <button type="button" class="quiet up" disabled={disabled || !i} aria-label={t('Move row {i} up', { i: k })} onclick={() => move(i, -1)}><Icon name="down" /></button>
    <button type="button" class="quiet" disabled={disabled || i === rows.length - 1} aria-label={t('Move row {i} down', { i: k })} onclick={() => move(i, 1)}><Icon name="down" /></button>
  </span>
{/snippet}

<!-- Adding: a keyed list's new element needs its key first; a form's is a
     draft. Suggestions: the action's button, then its rows to pick from. -->
{#snippet adder()}
  {#if fresh}
    <div class="new" bind:this={box}><Section sec={fresh.sec} save={create} values={fresh.values} /></div>
  {:else if resizable}
    <form class="add" onsubmit={(e) => (e.preventDefault(), add())}>
      {#if key && !form}<input bind:value={newKey} required placeholder={named?.label ?? key} aria-label={t('New')} {disabled} />{/if}
      <button disabled={disabled || full}><Icon name="plus" /> {full ? t('Add (max {n})', { n: leaf.maxSize! }) : t('Add')}</button>
      {#if via}
        <button type="button" disabled={disabled || looking} aria-busy={looking} onclick={look}>
          {session.schemaAt(via)?.label ?? humanize(via.slice(via.lastIndexOf('/') + 1))}{looking ? '…' : ''}
        </button>
      {/if}
    </form>
    {#if via && session.store.errors[via]}<p class="error" role="alert">{session.store.errors[via]}</p>{/if}
    {#if found}
      <div class="list">
        {#each found as r, i (i)}
          {@const k = String(cell(r, named))}
          <button type="button" class="quiet pick" {disabled} onclick={() => pick(r)}>
            <span class="name">{k}</span>
            {#if r.secure === true}<Icon name="lock" />{/if}
            <span class="muted">{dbm(r)}</span>
            {#if saved(k)}<span class="saved" title={t('Saved')}><Icon name="check" /></span>{/if}
          </button>
        {:else}
          <p class="muted">{t('Nothing found')}</p>
        {/each}
      </div>
    {/if}
  {/if}
{/snippet}

{#if leaf.widget === 'list'}
<div class="lv">
  <div class="list">
    {#each rows as row, i (id(row, i))}
      {@const k = id(row, i)}
      {@const path = `${leaf.path}/${k}`}
      <div class="item" class:open={open === k}>
        <div class="line">
          <button type="button" class="quiet head" aria-expanded={open === k} onclick={() => (open = open === k ? null : k)}>
            {#if mark}<span class="mark">{#if cell(row, mark) === true}<Icon name={mark.icon!} />{/if}</span>{/if}
            <span class="name">{key ? k : (text(cell(row, cols[0]), cols[0]) || `#${i + 1}`)}</span>
            <span class="muted sum">{shown.map((c) => text(cell(row, c), c)).filter(Boolean).join(' · ')}</span>
            <Icon name="down" />
          </button>
          {#if flag}
            <input type="checkbox" role="switch" checked={cell(row, flag) === true} {disabled} aria-label="{flag.label} {k}" onchange={(e) => session.store.write(`${path}/${flag.path}`, e.currentTarget.checked)} />
          {/if}
          {#each leaf.files ?? [] as f (f.name)}
            {@const fl = fileOf(f, path, k)}
            {#if !fl.visibleWhen || holds(fl.visibleWhen, get)}
              <File
                leaf={fl}
                value={undefined}
                set={() => {}}
                disabled={disabled || !session.can(fl.access) || (!!fl.enabledWhen && !holds(fl.enabledWhen, get))}
                id="f{leaf.path.replace(/[^\w-]/g, '_')}_{i}_{f.name}"
                compact
              />
            {/if}
          {/each}
          {#if leaf.reorder}{@render mover(i, k)}{/if}
          {#if resizable}
            <button type="button" class="quiet" {disabled} aria-label={t('Remove row {i}', { i: k })} onclick={() => remove(i)}><Icon name="trash" /></button>
          {/if}
        </div>
        {#if open === k}<div class="detail"><Section sec={detail(path)} /></div>{/if}
      </div>
    {:else}
      <p class="muted">{t('Empty')}</p>
    {/each}
  </div>
  {@render adder()}
</div>
{:else}

<div class="table">
  <table>
    <thead>
      <tr>
        {#if !leaf.key}<th scope="col">#</th>{/if}
        {#each cols as c (c.path)}<th scope="col">{c.label}</th>{/each}
        {#if leaf.reorder}<th><span class="sr">{t('Order')}</span></th>{/if}
        {#if resizable}<th><span class="sr">{t('Remove')}</span></th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each rows as row, i (i)}
        <tr>
          {#if !leaf.key}<td class="muted">{i}</td>{/if}
          {#each cols as c (c.path)}
            {@const v = cell(row, c)}
            <td>
              {#if !c.editable}
                {formatValue(v, c)}
              {:else if c.type === 'boolean'}
                <input type="checkbox" checked={v === true} {disabled} aria-label="{c.label} {i}" onchange={(e) => edit(i, c, e.currentTarget.checked)} />
              {:else if c.options}
                <select {disabled} aria-label="{c.label} {i}" onchange={(e) => edit(i, c, e.currentTarget.value)}>
                  {#each c.options as o (o.value)}<option value={o.value} selected={o.value === v}>{o.label}</option>{/each}
                </select>
              {:else if c.type === 'integer' || c.type === 'number'}
                <input
                  type="number"
                  min={c.min}
                  max={c.max}
                  step={c.step ?? 'any'}
                  value={v ?? ''}
                  {disabled}
                  aria-label="{c.label} {i}"
                  onchange={(e) => {
                    const n = parseNumber(e.currentTarget.value, c.type);
                    if (n !== undefined) edit(i, c, n);
                  }}
                />
              {:else if c.secret}
                <Secret show={t('Show password')} maxlength={c.maxLength} placeholder="••••••••" {disabled} label="{c.label} {i}" onchange={(e) => edit(i, c, e.currentTarget.value)} />
              {:else}
                <input type="text" maxlength={c.maxLength} value={v ?? ''} {disabled} aria-label="{c.label} {i}" onchange={(e) => edit(i, c, e.currentTarget.value)} />
              {/if}
            </td>
          {/each}
          {#if leaf.reorder}<td>{@render mover(i, i)}</td>{/if}
          {#if resizable}
            <td><button type="button" class="quiet" {disabled} aria-label={t('Remove row {i}', { i })} onclick={() => remove(i)}><Icon name="trash" /></button></td>
          {/if}
        </tr>
      {:else}
        <tr><td colspan={cols.length + 3} class="muted">{t('Empty')}</td></tr>
      {/each}
    </tbody>
  </table>
  {#if resizable}
    {@render adder()}
  {/if}
</div>
{/if}

<style>
  .move {
    display: inline-flex;
  }
  .up :global(svg) {
    transform: rotate(180deg);
  }
  .table {
    display: grid;
    gap: 8px;
    justify-items: start;
    min-width: 0;
    overflow-x: auto;
  }
  table {
    border-collapse: collapse;
    width: 100%;
  }
  th {
    text-align: left;
    font-weight: 500;
    color: var(--muted);
    font-size: 0.85em;
  }
  th,
  td {
    padding: 3px 6px 3px 0;
  }
  td input:not([type='checkbox']),
  td :global(.secret) {
    width: 100%;
    min-width: 6em;
  }
  .lv {
    display: grid;
    gap: 8px;
  }
  .list {
    display: grid;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px);
    overflow: hidden;
  }
  .list > p {
    margin: 0;
    padding: 10px 12px;
  }
  .item {
    min-width: 0;
  }
  .item + .item {
    border-top: 1px solid var(--border);
  }
  .item.open {
    background: var(--surface-2);
  }
  .line {
    display: flex;
    align-items: center;
    gap: 4px;
    padding-right: 6px;
  }
  .line > :global(input) {
    flex: none;
  }
  .head {
    flex: 1;
    justify-content: flex-start;
    min-width: 0;
    padding: 0 12px;
    border-radius: 0;
    text-align: left;
  }
  .name {
    font-weight: 550;
    flex: none;
  }
  .sum {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 0.9em;
  }
  .mark {
    width: 1.15em;
    flex: none;
    color: var(--muted);
  }
  .head > :global(.icon) {
    margin-left: auto;
    flex: none;
    color: var(--muted);
    transition: transform 0.15s;
  }
  .open .head > :global(.icon) {
    transform: rotate(180deg);
  }
  .detail {
    padding: 0 12px 10px;
  }
  .detail > :global(fieldset),
  .new > :global(fieldset) {
    margin: 0;
    padding: 0;
    border: 0;
  }
  .add {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .new {
    padding: 0 12px 10px;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px);
  }
  .pick {
    justify-content: flex-start;
    gap: 8px;
    padding: 0 12px;
    border-radius: 0;
    color: var(--muted);
  }
  .pick + .pick {
    border-top: 1px solid var(--border);
  }
  .pick .name {
    color: var(--text);
  }
  .saved {
    margin-left: auto;
    color: var(--accent);
  }
  .add input {
    flex: 1;
    max-width: 14em;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
</style>
