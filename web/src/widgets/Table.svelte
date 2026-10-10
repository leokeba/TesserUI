<script lang="ts">
  // Lists (DESIGN.md §4): one row per element, one column per leaf. Every
  // edit writes the whole array, as TesserAPI replaces lists (§4.4 there).
  import { isObject, parse, stringify } from '../client/json';
  import Icon from '../Icon.svelte';
  import { formatValue } from '../model/format';
  import type { Leaf } from '../model/model';
  import { parseNumber, type WidgetProps } from './types';
  let { leaf, value, set, disabled }: WidgetProps = $props();

  const rows = $derived(Array.isArray(value) ? value : []);
  const cols = $derived(leaf.columns ?? []);
  const full = $derived(leaf.maxSize !== undefined && rows.length >= leaf.maxSize);

  const copy = () => parse(stringify(rows)) as unknown[];
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
    set(next);
  }
  // New elements start from their defaults: an empty patch.
  const add = () => set([...copy(), cols.length === 1 && !cols[0].path ? null : {}]);
  const remove = (i: number) => set(copy().filter((_, j) => j !== i));
</script>

<div class="table">
  <table>
    <thead>
      <tr>
        <th scope="col">#</th>
        {#each cols as c (c.path)}<th scope="col">{c.label}</th>{/each}
        <th><span class="sr">Remove</span></th>
      </tr>
    </thead>
    <tbody>
      {#each rows as row, i (i)}
        <tr>
          <td class="muted">{i}</td>
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
                <input type="text" maxlength={c.maxLength} value={v ?? ''} {disabled} aria-label="{c.label} {i}" onchange={(e) => edit(i, c, e.currentTarget.value)} />
              {/if}
            </td>
          {/each}
          <td><button type="button" class="quiet" {disabled} aria-label="Remove row {i}" onclick={() => remove(i)}><Icon name="trash" /></button></td>
        </tr>
      {:else}
        <tr><td colspan={cols.length + 2} class="muted">Empty</td></tr>
      {/each}
    </tbody>
  </table>
  <button type="button" disabled={disabled || full} onclick={add}><Icon name="plus" /> Add{full ? ` (max ${leaf.maxSize})` : ''}</button>
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
