<script lang="ts" module>
  // Module scripts, each loaded once per page: resolves false on error.
  const scripts = new Map<string, Promise<boolean>>();
  function load(url: string): Promise<boolean> {
    let p = scripts.get(url);
    if (!p) {
      p = new Promise((done) => {
        const s = document.createElement('script');
        s.type = 'module';
        s.src = url;
        s.onload = () => done(true);
        s.onerror = () => done(false);
        document.head.append(s);
      });
      scripts.set(url, p);
    }
    return p;
  }
</script>

<script lang="ts">
  // A custom element (DESIGN.md §9.8): the node's value and schema go in as
  // properties, writes and calls come back through its `tesser` handle. If
  // it never gets defined, the inferred widget stands in.
  import { parse, stringify } from '../client/json';
  import { errorBody } from '../client/types';
  import { buildLeaf, toastKind } from '../model/model';
  import { parentPath } from '../model/schema';
  import { useSession } from '../shared.svelte';
  import JsonView from './JsonView.svelte';
  import { widgetOf } from './registry';
  import { nodeScript } from './script';
  import type { WidgetProps } from './types';

  let { leaf, value, set, disabled, id }: WidgetProps = $props();
  const session = useSession();
  const store = session.store;

  type Custom = HTMLElement & Record<string, unknown>;
  let host: HTMLDivElement | undefined = $state();
  let el: Custom | undefined = $state();
  let failed = $state(false);

  const copy = (v: unknown) => (v === undefined ? undefined : parse(stringify(v)));
  // Paths: relative to the node, or absolute within the node's tree.
  const abs = (p?: string) => {
    if (!p) return leaf.path;
    if (!p.startsWith('/')) return `${leaf.path}/${p}`;
    const root = session.nodeRoot(leaf.path);
    return root === '/' ? p : root + p;
  };
  const handle = {
    get path() {
      return leaf.path;
    },
    get: (p?: string) => copy(store.get(abs(p))),
    set(p: string | undefined, v: unknown, drag = false) {
      const a = abs(p);
      if (a === leaf.path) set(v, drag);
      else if (drag) store.writeSoon(a, v);
      else store.write(a, v);
    },
    async call(p: string | undefined, arg?: unknown) {
      const r = await store.call(abs(p), arg);
      if (r.status !== 'ok') throw errorBody(r);
      return r.body;
    },
    toast: (text: string, kind?: string) => store.toasts.show(String(text), toastKind(kind) ?? 'info'),
  };

  // svelte-ignore state_referenced_locally
  const tag = leaf.widget;
  // The page's scripts resolve against the page; a node's (ui.script)
  // against the node, i.e. its API's URL, and a path from its root against
  // the folder above its API: the node's root, also behind the bridge's
  // proxy (/n/<host>/api, DESIGN.md §9.8). Only paths on the node: a URL
  // elsewhere is refused, like a script that fails to load.
  // svelte-ignore state_referenced_locally
  const urls = [...(session.config.scripts ?? []).map((u) => new URL(u, location.href).href)];
  // svelte-ignore state_referenced_locally
  const script = leaf.script;
  const own = script && nodeScript(script, session.apiUrl());
  if (own) urls.push(own);
  else if (script) console.error(`<${tag}>: ui.script refused:`, script), (failed = !customElements.get(tag));
  for (const url of urls) load(url).then((ok) => ok || customElements.get(tag) || (failed = true));
  const timer = setTimeout(() => (failed = !customElements.get(tag)), 8000);
  customElements.whenDefined(tag).then(() => {
    clearTimeout(timer);
    try {
      const e = document.createElement(tag) as Custom;
      e.tesser = handle;
      e.schema = leaf.schema;
      e.label = leaf.label;
      el = e;
      failed = false;
    } catch (err) {
      // A broken element: the inferred widget instead.
      console.error(`<${tag}>:`, err);
      failed = true;
    }
  });
  $effect(() => () => clearTimeout(timer));
  $effect(() => {
    if (host && el && el.parentNode !== host) host.append(el);
  });
  $effect(() => {
    if (el) el.value = copy(value);
  });
  $effect(() => {
    if (!el) return;
    el.disabled = disabled;
    el.error = store.errors[leaf.path] ?? null;
  });

  // The inferred widget, without the custom one.
  const fallback = $derived(
    failed && leaf.type !== 'object'
      ? { ...buildLeaf(leaf.name, leaf.path, { ...leaf.schema, ui: { ...leaf.schema.ui, widget: '' } }, parentPath(leaf.path)), access: leaf.access }
      : null,
  );
  const Fallback = $derived(fallback ? widgetOf(fallback).component : null);
</script>

{#if failed}
  {#if fallback && Fallback}
    <Fallback leaf={fallback} {value} {set} {disabled} {id} />
  {:else}
    <JsonView leaf={{ ...leaf, widget: 'json', editable: false }} {value} {set} {disabled} {id} />
  {/if}
{:else}
  <div class="element" bind:this={host}></div>
{/if}

<style>
  .element {
    min-width: 0;
    width: 100%;
  }
</style>
