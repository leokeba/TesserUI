<script lang="ts">
  // A launcher's workspace (DESIGN.md §9.7.2): several connections at once,
  // each a Session, every node of every connection a tab. The connections
  // are remembered for the next visit (USB ports open on a click), and the
  // nodes the bridge finds join by themselves. One device reached several ways is one
  // tab (devices.ts). A node's own scripts (ui.script) run only for the
  // connections the user added or opened, not for every node the bridge
  // finds: they run beside every saved node's token (DESIGN.md §9.8).
  import App, { type Tab } from '../App.svelte';
  import { NUS_SERVICE } from '../client/envelope';
  import { HttpClient } from '../client/http';
  import Connect from '../Connect.svelte';
  import { resolve, type Options } from '../embed';
  import { parentPath, type Schema } from '../model/schema';
  import { Session, storageGet, storageSet } from '../store/session.svelte';
  import Claim from './Claim.svelte';
  import { onePerDevice } from './devices';
  import Ways, { type Nearby } from './Ways.svelte';

  let { options }: { options: Options } = $props();

  // How a connection is opened again: its API, its USB port's identity (the
  // n-th port with it), or its Bluetooth device's id.
  type Saved = { key: string; label?: string } & ({ api: string; ws?: string | null } | { usb: [number, number] } | { ble: string });
  interface Conn {
    key: string;
    // null: remembered, not open (a port or device that needs a click).
    session: Session | null;
    // null: not remembered (found by the bridge, or a line without identity).
    saved: Saved | null;
    // Its route while another connection is shown.
    hash: string;
    // Opened (a line is from the start). A node on the network isn't until
    // it is shown, or apply to all reaches it: meanwhile its root is read
    // every 30 s (`peek`), and it holds no WebSocket, subscription or
    // events stream of the node's few (DESIGN.md §9.7.2).
    live?: boolean;
    peek?: { ok: boolean; label?: string; id?: string };
  }
  type Port = Parameters<Session['useSerial']>[0];
  type Device = Parameters<Session['useBle']>[0];
  const NODES = 'tesserui:nodes';
  const ACTIVE = 'tesserui:active';
  const BRIDGE = 'tesserui:bridge';
  const nav = navigator as unknown as {
    serial?: { getPorts?(): Promise<Port[]>; requestPort(o: object): Promise<Port> };
    bluetooth?: { getDevices?(): Promise<Device[]>; requestDevice(o: object): Promise<Device> };
  };

  let conns: Conn[] = $state([]);
  // The connection shown; null: the connection screen.
  let active = $state<Conn | null>(null);
  let ready = false;
  let lines = 0;
  // Connections closed by hand: the bridge doesn't bring them back.
  const dismissed = new Set<string>();

  // The connection screen's session: a line chosen there (USB, Bluetooth)
  // makes it a connection, remembered by the port's USB identity or the
  // device's id when the browser gives them.
  class Line extends Session {
    key?: string;
    port?: Port;
    useSerial(port: Port) {
      this.port = port;
      super.useSerial(port);
      const i = (port as { getInfo?(): { usbVendorId?: number; usbProductId?: number } }).getInfo?.();
      const usb: [number, number] | null = i?.usbVendorId ? [i.usbVendorId, i.usbProductId ?? 0] : null;
      const prefix = usb && `usb:${usb.join(':')}:`;
      // A remembered port that wasn't open, or the next of its kind.
      const key = (this.key ??= prefix
        ? (conns.find((c) => c.key.startsWith(prefix) && !c.session)?.key ?? prefix + conns.filter((c) => c.key.startsWith(prefix)).length)
        : undefined);
      joined(this, usb && key ? { key, usb } : null);
    }
    useBle(device: Device) {
      super.useBle(device);
      joined(this, device.id ? { key: `ble:${device.id}`, ble: device.id } : null);
    }
  }
  const line = (key?: string) => Object.assign(new Line(resolve({ ...options, transport: 'serial' })), { key });
  let screen = $state(line());
  const shown = $derived(active?.session ?? screen);

  // Apply to all reaches the other connections' nodes too (DESIGN.md §6.6).
  function setup(s: Session) {
    s.others = (rel, body) => conns.filter((c) => c.live && c.session !== s).map((c) => c.session!.applyHere(rel, body));
  }

  function open(c: Conn) {
    if (c.live || !c.session) return;
    c.live = true;
    c.session.start();
  }

  async function peek(c: Conn) {
    const s = c.session!;
    // Its own client, closed after: a failed read would probe on otherwise.
    const client = new HttpClient(s.apiUrl(), () => s.token());
    const r = await client.request({ op: 'get', path: '/', view: 'schema', depth: 0 }, 5000);
    client.close();
    const b = r.status === 'ok' ? (r.body as Schema) : null;
    if (!c.live) c.peek = { ok: !!b || r.status === 'unauthorized', label: b?.label, id: b?.id };
  }
  $effect(() => {
    const timer = setInterval(() => conns.forEach((c) => c.session && !c.live && peek(c)), 30000);
    return () => clearInterval(timer);
  });

  function joined(s: Session, saved: Saved | null) {
    const key = saved?.key ?? `line:${++lines}`;
    const c: Conn = { key, session: s, saved, hash: '', live: true };
    const i = conns.findIndex((x) => x.key === key);
    if (i < 0) conns.push(c);
    else conns[i] = { ...c, saved: { ...conns[i].saved, ...saved! } };
    setup(s);
    if (s === screen) screen = line();
    remember();
    if (ready) activate(conns.find((x) => x.key === key)!);
  }

  // A node on the network, or behind the bridge's proxy.
  function network(api: string, ws?: string | null, saved = true): Conn {
    const url = new URL(api, location.href).href.replace(/\/$/, '');
    const key = `api:${url} ${ws ?? ''}`;
    const known = conns.find((c) => c.key === key);
    if (known) return known;
    const s = new Session(resolve({ ...options, api: url, ws, transport: undefined }));
    s.nodeScripts = saved;
    setup(s);
    conns.push({ key, session: s, saved: saved ? { key, api: url, ws } : null, hash: '' });
    remember();
    const c = conns[conns.length - 1];
    peek(c);
    return c;
  }

  function remember() {
    storageSet(NODES, JSON.stringify(conns.filter((c) => c.saved).map((c) => ({ ...c.saved, label: label(c) }))));
  }

  function label(c: Conn): string {
    const s = c.session;
    if (s?.loaded) return s.nodeLabel('/');
    const saved = c.saved;
    return c.peek?.label ?? saved?.label ?? (saved && 'api' in saved ? new URL(saved.api).host : screen.t('Connecting…'));
  }

  // Shown: the others keep only their remote nodes' stubs watched, for the
  // tabs' online states.
  function activate(c: Conn | null, hash?: string) {
    const was = active;
    if (was && was !== c) {
      was.hash = location.hash;
      const s = was.session;
      s?.subs.want([...new Set(s.nodes().map(parentPath))].map((path) => ({ path, depth: 1 })));
    }
    if (c) open(c);
    history.replaceState(null, '', hash ?? c?.hash ?? '#');
    if (c?.session) c.session.all = shown.all;
    active = c;
    storageSet(ACTIVE, c?.key ?? null);
  }

  // Chosen by the user: its node's scripts may run.
  function pick(c: Conn, hash?: string) {
    if (c.session) c.session.nodeScripts = true;
    activate(c, hash);
  }

  // The shown one closed, the next the user added or opened is shown.
  function close(c: Conn) {
    c.session?.close();
    dismissed.add(c.key);
    conns.splice(conns.indexOf(c), 1);
    remember();
    if (active !== c) return;
    active = null;
    activate(conns.find((x) => x.session?.nodeScripts) ?? null);
  }

  // A remembered port, or a device that didn't open by itself, opens on a
  // click: opening a port resets most boards, a running motor controller
  // included. A port this page was given before opens at once when it is
  // the only one with its USB ids not open already; otherwise the browser's
  // chooser, narrowed to them, lets the user tell boards of a kind apart.
  async function reopen(c: Conn) {
    const saved = c.saved!;
    const s = line(c.key);
    try {
      if ('usb' in saved) {
        const [vendor, product] = saved.usb;
        const used = conns.map((x) => (x.session as Line | null)?.port);
        const free = ((await nav.serial!.getPorts?.()) ?? []).filter((p) => {
          const i = (p as { getInfo?(): { usbVendorId?: number; usbProductId?: number } }).getInfo?.();
          return !used.includes(p) && i?.usbVendorId === vendor && i?.usbProductId === product;
        });
        s.useSerial(free.length === 1 ? free[0] : await nav.serial!.requestPort({ filters: [{ usbVendorId: vendor, usbProductId: product }] }));
      } else if ('ble' in saved) s.useBle(await nav.bluetooth!.requestDevice({ filters: [{ services: [NUS_SERVICE] }] }));
    } catch {
      // dismissed
    }
  }

  // One tab per device (devices.ts).
  const tabs = $derived.by(() => {
    const paths = onePerDevice(
      conns.map(({ session: s }) => {
        void s?.schemaVersion;
        return s?.loaded ? { id: s.root.id, nodes: s.nodes().map((p): [string, string | undefined] => [p, s.schemaAt(p)?.id]) } : null;
      }),
    );
    return conns.map((c, i) => ({ c, paths: paths[i] }));
  });
  $effect(() => {
    for (const { c, paths } of tabs) {
      if (!paths) continue;
      c.session!.only = paths;
      // The same node again, found by the bridge: closed.
      if (!paths.length && !c.saved) close(c);
    }
  });
  // One events subscription per device (DESIGN.md §9.7.2), which allows two
  // streams: the first live connection to it holds it, and passes its events
  // to the others reaching it. A device by its id, else by its API's URL.
  $effect(() => {
    const holders = new Map<string, Session>();
    for (const c of conns) {
      const s = c.session;
      if (!s) continue;
      void s.schemaVersion;
      const network = s.kind === 'ws' || s.kind === 'http';
      const id = c.live && s.loaded && s.state === 'open' ? (s.root.id ?? (network ? s.apiUrl() : undefined)) : undefined;
      const holder = id ? holders.get(id) : undefined;
      if (id && !holder) holders.set(id, s);
      s.eventsFrom(holder ?? null);
    }
  });
  // Every connection's remote nodes are labelled from their own roots, as
  // the shown one's are (App), each read once per advertised hash.
  const labelled = new Set<string>();
  $effect(() => {
    for (const { c, paths } of tabs) {
      const s = c.session!;
      for (const p of paths?.slice(1) ?? []) {
        const key = c.key + p + ' ' + s.schemaAt(p)?.schema;
        if (labelled.has(key) || s.schemaAt(p)?.tree || s.isOffline(p)) continue;
        labelled.add(key);
        s.fetchSchema(p, 0);
      }
    }
  });
  // Labels follow the nodes' own, for the next visit.
  $effect(() => {
    for (const c of conns) {
      if (c.saved && c.session?.loaded && c.saved.label !== c.session.nodeLabel('/')) {
        c.saved.label = c.session.nodeLabel('/');
        remember();
      }
    }
  });
  // Apply to all, turned on, reaches every connection: each opens. Turned
  // off, every connection's marks go.
  $effect(() => {
    for (const c of conns) if (shown.all) open(c);
    else if (c.session) c.session.applied = {};
  });

  function tabsOf(c: Conn, paths: string[] | null): Tab[] {
    const s = c.session;
    if (!s || !paths) return [{ key: c.key, label: label(c), off: c.live ? s?.state !== 'open' : !c.peek?.ok, go: () => (s ? pick(c) : reopen(c)) }];
    return paths.map((p) => {
      const stub = s.schemaAt(p);
      return {
        key: c.key + p,
        label: s.nodeLabel(p),
        off: p === '/' ? s.state !== 'open' : stub?.online === false,
        title: [stub?.id, stub?.route].filter(Boolean).join(' · '),
        mark: shown.all ? s.applied[p] : undefined,
        go: () => pick(c, `#${p}`),
      };
    });
  }
  // The other connections' tabs, before and after the shown one's.
  const around = $derived.by((): [Tab[], Tab[]] => {
    const i = tabs.findIndex((x) => x.c === active);
    const out: [Tab[], Tab[]] = [[], []];
    tabs.forEach((x, j) => j !== i && out[i >= 0 && j > i ? 1 : 0].push(...tabsOf(x.c, x.paths)));
    return out;
  });

  // The bridge (tesserui-bridge): the nodes it finds join as connections,
  // not remembered (it finds them again), unless one already reaches them.
  // A public page asks for it once by hand (DESIGN.md §9.7), since Chrome
  // asks before it reaches localhost; after one answer, it asks every 5 s.
  const q = new URLSearchParams(location.search);
  const own = !!document.querySelector('meta[name=tesserui-bridge]');
  const bridge = own ? location.origin : (q.get('bridge') ?? 'http://localhost:8765');
  let nearby: Nearby | null = $state(null);
  async function look() {
    try {
      const r = await fetch(`${bridge}/nodes`, { signal: AbortSignal.timeout(3000) });
      nearby = (await r.json()) as Nearby;
      storageSet(BRIDGE, '1');
    } catch {
      nearby = null;
      return;
    }
    const roots = conns.map((c) => (c.session?.loaded ? c.session.root.id : c.peek?.id));
    for (const n of nearby.nodes) {
      const key = `api:${n.api} ${n.ws ?? ''}`;
      if (!dismissed.has(key) && !(n.device && roots.includes(n.device))) network(n.api, n.ws, false);
    }
  }
  $effect(() => {
    if (!own && storageGet(BRIDGE) !== '1') return;
    look();
    const timer = setInterval(look, 5000);
    return () => clearInterval(timer);
  });

  // The remembered connections, as tabs: a USB port waits for a click
  // (reopen), since opening it resets the board; a Bluetooth device this
  // browser was given before connects without asking. Then ?api= joins, and
  // is shown.
  (async () => {
    let saved: Saved[] = [];
    try {
      saved = JSON.parse(storageGet(NODES) ?? '[]');
    } catch {
      // a broken entry: forgotten
    }
    const devices = (await nav.bluetooth?.getDevices?.().catch(() => [])) ?? [];
    for (const s of saved) {
      if ('api' in s) {
        network(s.api, s.ws).saved!.label = s.label;
        continue;
      }
      conns.push({ key: s.key, session: null, saved: s, hash: '' });
      const d = 'ble' in s && devices.find((x) => x.id === s.ble);
      if (d) line(s.key).useBle(d);
    }
    ready = true;
    const last = storageGet(ACTIVE);
    if (q.has('api')) activate(network(options.api, options.ws), location.hash);
    else activate(conns.find((c) => c.key === last && c.session) ?? conns.find((c) => c.session) ?? null, location.hash);
  })();
</script>

{#key shown}
  <App session={shown} full {around} add={() => activate(null)} close={active ? () => close(active!) : undefined}>
    {#snippet connect()}
      <Connect>
        {#snippet children(pick, ble)}
          <Ways {pick} {ble} {nearby} {look} {bridge} open={(api, ws) => activate(network(api, ws))} />
        {/snippet}
      </Connect>
    {/snippet}
    {#if shown.config.claim}<Claim session={shown} />{/if}
  </App>
{/key}
