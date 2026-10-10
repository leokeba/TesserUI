<script lang="ts">
  // Lists and arrays (DESIGN.md §4). A table: one row per element, one column
  // per leaf; every edit writes the whole array, as TesserAPI replaces lists
  // (§4.4 there), and keyed lists match rows by key, so unread secrets
  // survive. A list (widget "list"): one line per element, which opens into
  // the element's own controls, each writing its own path.
  import { isObject, parse, stringify } from '../client/json';
  import Icon from '../Icon.svelte';
  import Section from '../Section.svelte';
  import { formatValue } from '../model/format';
  import { buildSection, type Leaf } from '../model/model';
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
  function send(next: unknown[]) {
    for (const row of next) {
      for (const c of omitted) {
        const names = c.path.split('/');
        let o: unknown = row;
        for (const n of names.slice(0, -1)) o = isObject(o) ? o[n] : undefined;
        const last = names[names.length - 1];
        if (isObject(o) && (!c.editable || o[last] === null)) delete o[last];
      }
    }
    set(next);
  }
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
  // list, one naming its key.
  let newKey = $state('');
  function add() {
    send([...copy(), leaf.key ? { [leaf.key]: newKey } : cols.length === 1 && !cols[0].path ? null : {}]);
    if (leaf.key) open = newKey;
    newKey = '';
  }
  const remove = (i: number) => send(copy().filter((_, j) => j !== i));

  // List lines: the element's name (its key, else its first value), up to
  // three short values, and its first boolean as a switch.
  // svelte-ignore state_referenced_locally
  const key = leaf.key;
  // svelte-ignore state_referenced_locally
  if (key) session.store.keys.set(leaf.path, key);
  const id = (row: unknown, i: number) => String(key && isObject(row) ? row[key] : i);
  let open: string | null = $state(null);
  const top = $derived(cols.filter((c) => !c.path.includes('/') && c.path !== key && !c.secret));
  const flag = $derived(top.find((c) => c.type === 'boolean' && c.editable));
  const shown = $derived(top.filter((c) => c !== flag && c.type !== 'boolean').slice(0, 3));
  function text(v: unknown, c: Leaf): string {
    if (v === '' || v === undefined || v === null) return '';
    if (c.widget === 'flags') {
      const labels = (c.schema.ui?.labels as string | undefined)?.split(',') ?? [];
      return labels.filter((_, b) => (Number(v) >> b) & 1).join(' ');
    }
    return c.options?.find((o) => o.value === v)?.label ?? formatValue(v, c);
  }
  // The element's controls, built when it opens.
  const detail = (path: string) => ({
    ...buildSection(path, leaf.schema.items!, 2, session.nodeRoot(leaf.path), leaf.access),
    label: '',
  });
</script>

<!-- Adding: a keyed list's new element needs its key first. -->
{#snippet adder()}
  {#if resizable}
    <form class="add" onsubmit={(e) => (e.preventDefault(), add())}>
      {#if key}<input bind:value={newKey} required placeholder={cols.find((c) => c.path === key)?.label ?? key} aria-label={t('New')} {disabled} />{/if}
      <button disabled={disabled || full}><Icon name="plus" /> {full ? t('Add (max {n})', { n: leaf.maxSize! }) : t('Add')}</button>
    </form>
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
            <span class="name">{key ? k : (text(cell(row, cols[0]), cols[0]) || `#${i + 1}`)}</span>
            <span class="muted sum">{shown.map((c) => text(cell(row, c), c)).filter(Boolean).join(' · ')}</span>
            <Icon name="down" />
          </button>
          {#if flag}
            <input type="checkbox" role="switch" checked={cell(row, flag) === true} {disabled} aria-label="{flag.label} {k}" onchange={(e) => session.store.write(`${path}/${flag.path}`, e.currentTarget.checked)} />
          {/if}
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
              {:else}
                <input
                  type={c.secret ? 'password' : 'text'}
                  maxlength={c.maxLength}
                  placeholder={c.secret ? '••••••••' : undefined}
                  value={v ?? ''}
                  {disabled}
                  aria-label="{c.label} {i}"
                  onchange={(e) => edit(i, c, e.currentTarget.value)}
                />
              {/if}
            </td>
          {/each}
          {#if resizable}
            <td><button type="button" class="quiet" {disabled} aria-label={t('Remove row {i}', { i })} onclick={() => remove(i)}><Icon name="trash" /></button></td>
          {/if}
        </tr>
      {:else}
        <tr><td colspan={cols.length + 2} class="muted">{t('Empty')}</td></tr>
      {/each}
    </tbody>
  </table>
  {#if resizable}
    {@render adder()}
  {/if}
</div>
{/if}

<style>
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
  td input[type='number'],
  td input[type='text'] {
    width: 100%;
    min-width: 4em;
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
  .head :global(.icon) {
    margin-left: auto;
    flex: none;
    color: var(--muted);
    transition: transform 0.15s;
  }
  .open .head :global(.icon) {
    transform: rotate(180deg);
  }
  .detail {
    padding: 0 12px 10px;
  }
  .detail > :global(fieldset) {
    margin: 0;
    padding: 0;
    border: 0;
  }
  .add {
    display: flex;
    gap: 8px;
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
