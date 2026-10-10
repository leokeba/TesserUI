<script lang="ts">
  // Lists and arrays (DESIGN.md §4): one row per element, one column per
  // leaf. Every edit writes the whole array, as TesserAPI replaces lists
  // (§4.4 there); keyed lists match rows by key, so unread secrets survive.
  import { isObject, parse, stringify } from '../client/json';
  import Icon from '../Icon.svelte';
  import { formatValue } from '../model/format';
  import type { Leaf } from '../model/model';
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
  // New elements start from their defaults: an empty patch.
  const add = () => send([...copy(), cols.length === 1 && !cols[0].path ? null : {}]);
  const remove = (i: number) => send(copy().filter((_, j) => j !== i));
</script>

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
    <button type="button" disabled={disabled || full} onclick={add}><Icon name="plus" /> {full ? t('Add (max {n})', { n: leaf.maxSize! }) : t('Add')}</button>
  {/if}
</div>

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
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
</style>
