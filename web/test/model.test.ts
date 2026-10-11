import { describe, expect, it } from 'vitest';
import { buildMenu } from '../src/model/menu';
import { buildLeaf, buildPage, depthOf, inferWidget, placeCards, visiblePaths, weight, type Leaf, type Section } from '../src/model/model';
import { isCut, mergeSchema, remoteOf, schemaAt, type Schema } from '../src/model/schema';
import { fixture } from './fixtures';

const leaf = (s: Schema, name = 'x') => buildLeaf(name, `/${name}`, s, '/');

describe('widget inference (DESIGN §4)', () => {
  it('maps every tier-0 type', () => {
    expect(leaf({ type: 'boolean', writable: true }).widget).toBe('toggle');
    expect(leaf({ type: 'boolean' }).widget).toBe('led');
    expect(leaf({ type: 'integer', writable: true, min: 0, max: 255 }).widget).toBe('slider');
    expect(leaf({ type: 'number', writable: true }).widget).toBe('number');
    expect(leaf({ type: 'number' }).widget).toBe('readout');
    expect(leaf({ type: 'string', writable: true, enum: ['off', 'auto', 'manual'] }).widget).toBe('segmented');
    expect(leaf({ type: 'string', writable: true, enum: ['a', 'b', 'c', 'd', 'e'] }).widget).toBe('select');
    expect(leaf({ type: 'string', writable: true, enum: ['off', 'automatically'] }).widget).toBe('select');
    expect(leaf({ type: 'string', writable: true }).widget).toBe('text');
    expect(leaf({ type: 'string', enum: ['a'] }).widget).toBe('readout');
    expect(leaf({ type: 'action' }).widget).toBe('button');
    expect(leaf({ type: 'event' }).widget).toBe('events');
    expect(leaf({ type: 'list', maxSize: 4, items: { type: 'object', children: {} } }).widget).toBe('table');
    expect(leaf({ type: 'custom' }).widget).toBe('json');
  });
  it('builds typed action fields', () => {
    const a = leaf({ type: 'action', arg: 'number', min: 0, max: 360, unit: '°' });
    expect(a).toMatchObject({ widget: 'button', field: 'slider', type: 'number', min: 0, max: 360, unit: '°', editable: true });
    expect(leaf({ type: 'action', arg: 'integer' }).field).toBe('number');
    expect(leaf({ type: 'action', arg: 'boolean' }).field).toBe('toggle');
    expect(leaf({ type: 'action', arg: 'any' })).toMatchObject({ field: 'json', advanced: true });
    expect(leaf({ type: 'action', arg: 'any', deferred: true })).toMatchObject({ widget: 'button', deferred: true, advanced: false });
    expect(leaf({ type: 'action', returns: 'integer' }).returns).toBe('integer');
    expect(leaf({ type: 'action', arg: 'boolean', ui: { widget: 'hold' } }).widget).toBe('hold');
    expect(leaf({ type: 'action', arg: 'integer', ui: { widget: 'button', value: 3 } })).toMatchObject({ widget: 'button', value: 3 });
  });
  it('applies widget hints that fit, and falls back otherwise (DESIGN §5)', () => {
    expect(inferWidget({ type: 'number', min: 0, max: 1, ui: { widget: 'knob' } }, 'number', true)).toBe('knob');
    expect(inferWidget({ type: 'number', ui: { widget: 'knob' } }, 'number', true)).toBe('number');
    expect(inferWidget({ type: 'string', ui: { widget: 'knob' } }, 'string', true)).toBe('text');
    expect(inferWidget({ type: 'number', ui: { widget: 'gauge' } }, 'number', false)).toBe('readout');
    expect(inferWidget({ type: 'number', min: 0, max: 9, ui: { widget: 'gauge' } }, 'number', false)).toBe('gauge');
    expect(inferWidget({ type: 'boolean', ui: { widget: 'led' } }, 'boolean', true)).toBe('led');
    expect(inferWidget({ type: 'boolean', ui: { widget: 'checkbox' } }, 'boolean', false)).toBe('led');
    expect(leaf({ type: 'integer', writable: true, min: 0, max: 3, ui: { readonly: true } })).toMatchObject({ widget: 'readout', editable: false });
  });
  it('derives labels, options and precision', () => {
    const l = leaf({ type: 'string', writable: true, enum: ['off', 'auto', 'manual'], ui: { labels: 'Off,Automatic,Manual' } }, 'lampMode');
    expect(l.label).toBe('Lamp mode');
    expect(l.options).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'auto', label: 'Automatic' },
      { value: 'manual', label: 'Manual' },
    ]);
    expect(leaf({ type: 'number', writable: true, step: 0.01 }).precision).toBe(2);
    expect(leaf({ type: 'number', ui: { precision: 1 } }).precision).toBe(1);
    expect(leaf({ type: 'integer', writable: true }).step).toBe(1);
    expect(leaf({ type: 'number', ui: { widget: 'chart' } }).history).toBe(60);
  });
  it("chooses among a keyed list's keys (ui.options)", () => {
    const s: Schema = { type: 'string', writable: true, ui: { options: 'directions', optionsExtra: 'Sun' } };
    expect(buildLeaf('source', '/heliostat/source', s, '/heliostat')).toMatchObject({
      widget: 'select',
      options: [{ value: 'Sun', label: 'Sun' }],
      optionsFrom: '/heliostat/directions',
    });
    expect(leaf({ ...s, ui: { options: '/d', widget: 'radio' } }).widget).toBe('radio');
    expect(leaf({ ...s, writable: false })).toMatchObject({ widget: 'readout' });
    expect(leaf({ type: 'action', arg: 'string', ui: { options: '/d' } })).toMatchObject({ field: 'select', optionsFrom: '/d' });
    // A table cell can't follow another list: such rows open instead.
    const items: Schema = { type: 'object', children: { to: { ...s, ui: { options: '/d' } } } };
    expect(leaf({ type: 'list', items }).widget).toBe('list');
    // Relative like a condition's, absolute within the node's tree.
    expect(buildLeaf('t', '/peers/p/h/t', { ...s, ui: { options: '../d' } }, '/peers/p/h', '/peers/p').optionsFrom).toBe('/peers/p/d');
    expect(buildLeaf('t', '/peers/p/h/t', { ...s, ui: { options: '/d' } }, '/peers/p/h', '/peers/p')).toMatchObject({ optionsFrom: '/peers/p/d', options: [] });
  });
});

describe('layout of the test firmware (DESIGN §6.1)', () => {
  const fw = fixture('testfw');
  const page = buildPage(fw.schema, '/');

  it('makes each top-level object a card, in declaration order', () => {
    expect(page.cards.map((c) => c.label)).toEqual([
      'Lamp', 'Sensors', 'Config', 'System', 'Demo', 'Settings', 'Secure', 'Net', 'Peers', 'Nodes',
    ]);
  });
  it('turns a nested object into a sub-section', () => {
    const config = page.cards[2];
    const numbers = config.items.find((i) => i.name === 'numbers') as Section;
    expect(numbers).toMatchObject({ kind: 'section', level: 2, label: 'Numbers' });
  });
  it('puts remote nodes in link cards', () => {
    const peers = page.cards[8];
    expect(peers.items).toMatchObject([{ kind: 'link', remote: true, online: true, schemaHash: '552641a1', path: '/peers/tesser-f37c' }]);
    expect(page.cards[9].items).toMatchObject([{ kind: 'link', name: 'peer', path: '/peer' }]);
  });
  it('puts raw-argument actions under Advanced', () => {
    const demo = page.cards[4];
    expect(demo.items.map((i) => i.name)).toEqual(['running', 'counter', 'ticks', 'fired']);
    expect(demo.advancedItems.map((i) => i.name)).toEqual(['fire']);
  });
  it('subscribes without the mirrored remote node', () => {
    expect(page.keys?.split(',')).not.toContain('peer');
    expect(page.keys?.split(',')).toContain('peers');
    expect(page.depth).toBe(3);
  });
  it('lists visible paths', () => {
    const v = visiblePaths(page);
    expect(v.has('/lamp/brightness')).toBe(true);
    expect(v.has('/config/numbers/huge')).toBe(true);
  });
  it('marks objects whose schema was cut by depth as lazy', () => {
    const p = buildPage({ type: 'object', children: { a: { type: 'object', children: { b: { type: 'object' } } } } }, '/');
    expect((p.cards[0].items[0] as Section).lazy).toBe(true);
    expect(depthOf(fw.schema)).toBe(3);
  });
  it("reads lists' elements in full", () => {
    // TesserKIT's /sys/network: a read stopping at the list gets [].
    const networks: Schema = {
      type: 'list',
      key: 'ssid',
      items: { type: 'object', children: { ssid: { type: 'string', writable: true }, static: { type: 'object', children: { ip: { type: 'string' } } } } },
    };
    expect(depthOf(networks)).toBe(2);
    expect(depthOf({ type: 'object', children: { wifi: { type: 'object', children: { networks } } } })).toBe(4);
    expect(depthOf({ type: 'array', items: { type: 'integer' } })).toBe(0);
    expect(isCut(networks)).toBe(false);
    expect(isCut({ ...networks, items: undefined })).toBe(true);
    expect(isCut({ ...networks, items: { type: 'object', children: { static: { type: 'object' } } } })).toBe(true);
  });
  it('shows a custom node as JSON', () => {
    const net = page.cards[7];
    expect((net.items.find((i) => i.name === 'peers') as Leaf).widget).toBe('json');
  });
});

describe('schema tree', () => {
  it('merges deeper fetches and crosses remote nodes', () => {
    const fw = fixture('testfw');
    const root: Schema = { type: 'object' };
    mergeSchema(root, '/', { type: 'object', children: { peers: { type: 'object' } } });
    mergeSchema(root, '/peers', fw.peersSchema!);
    expect(schemaAt(root, '/peers/tesser-f37c')?.type).toBe('remote');
    mergeSchema(root, '/peers/tesser-f37c', fw.schema);
    expect(schemaAt(root, '/peers/tesser-f37c/lamp/brightness')).toMatchObject({ type: 'integer', max: 255 });
    expect(remoteOf(root, '/peers/tesser-f37c/lamp')?.path).toBe('/peers/tesser-f37c');
    // A narrowed refresh of the stub keeps the fetched tree and the siblings.
    mergeSchema(root, '/', { type: 'object', children: { other: { type: 'boolean' } } });
    mergeSchema(root, '/peers', { type: 'object', children: { 'tesser-f37c': { type: 'remote', online: false, schema: '552641a1' } } });
    expect(Object.keys(root.children!)).toEqual(['peers', 'other']);
    expect(schemaAt(root, '/peers/tesser-f37c')?.online).toBe(false);
    expect(schemaAt(root, '/peers/tesser-f37c/lamp/on')?.type).toBe('boolean');
    // A new advertised hash drops the cached tree.
    mergeSchema(root, '/peers', { type: 'object', children: { 'tesser-f37c': { type: 'remote', schema: '00000000' } } });
    expect(schemaAt(root, '/peers/tesser-f37c/lamp')).toBeUndefined();
  });
});

describe('menu (DESIGN §6.3)', () => {
  const root: Schema = {
    type: 'object',
    children: {
      uptime: { type: 'integer' },
      heliostat: { type: 'object', label: 'Heliostat', ui: { icon: 'sun' }, children: { mode: { type: 'string' } } },
      azimuth: { type: 'object', ui: { group: 'Controllers' }, children: {} },
      artnet: { type: 'object', label: 'Art-Net', ui: { group: 'Connections' }, children: {} },
      elevation: { type: 'object', ui: { group: 'Controllers' }, children: {} },
      secret: { type: 'object', ui: { hidden: true }, children: {} },
      peers: { type: 'object', label: 'Nodes', children: { lamp: { type: 'remote', online: false, schema: 'ab' } } },
      sys: { type: 'object', label: 'System', ui: { page: true }, children: { network: { type: 'object', children: {} }, timers: { type: 'list', key: 'name', items: { type: 'object', children: {} } }, reboot: { type: 'action' } } },
      _ui: { type: 'custom', ui: { hidden: true } },
    },
  };
  it('lists views, the status, then objects and nodes in tree order', () => {
    expect(buildMenu(root, '/', [{ id: 'field', label: 'Field', items: [] }])).toEqual([
      { label: 'Field', href: '#/v/field' },
      { label: 'Status', icon: 'home', href: '#/' },
      { label: 'Heliostat', icon: 'sun', href: '#/heliostat' },
      { label: 'Controllers', children: [{ label: 'Azimuth', href: '#/azimuth' }, { label: 'Elevation', href: '#/elevation' }] },
      { label: 'Connections', children: [{ label: 'Art-Net', href: '#/artnet' }] },
      { label: 'Nodes', href: '#/peers', children: [{ label: 'lamp', href: '#/peers/lamp', online: false }] },
      { label: 'System', href: '#/sys', children: [{ label: 'Network', href: '#/sys/network' }, { label: 'Timers', href: '#/sys/timers' }] },
    ]);
  });
  it('has no status entry without values of its own, and starts from a subtree', () => {
    const sub: Schema = { type: 'object', children: { a: { type: 'object', children: { b: { type: 'object', children: {} } } } } };
    expect(buildMenu(sub, '/motor', null)).toEqual([{ label: 'A', href: '#/motor/a' }]);
  });
  it("makes a list's page one card", () => {
    const page = buildPage(root.children!.sys.children!.timers, '/sys/timers');
    expect(page.label).toBe('Timers');
    expect(page.cards).toHaveLength(1);
    expect(page.cards[0].items[0]).toMatchObject({ path: '/sys/timers', label: '', key: 'name' });
  });
  it("shows the start page's own values only", () => {
    const page = buildPage(root, '/', '/', undefined, undefined, true);
    const shown = page.cards.filter((c) => !c.hidden).map((c) => c.items.filter((i) => !i.hidden).map((i) => i.path));
    expect(shown).toEqual([['/uptime']]);
    // Read: its own values (hidden ones too, for conditions), not the
    // entries' subtrees.
    expect(page.keys).toBe('uptime,secret,_ui');
  });
});

describe('columns (DESIGN §6.2)', () => {
  const values = (n: number): Schema => ({ type: 'object', children: Object.fromEntries([...Array(n)].map((_, i) => [`v${i}`, { type: 'integer' }])) });
  const page = buildPage(
    {
      type: 'object',
      children: {
        system: { type: 'object', label: 'System', children: { status: { type: 'string' } } },
        heliostat: values(12),
        azimuth: { type: 'object', children: { position: { type: 'number', ui: { widget: 'chart' } }, ...values(10).children } },
        elevation: values(13),
        settings: { type: 'object', ui: { collapsed: true }, children: values(30).children },
      },
    },
    '/',
  );
  const [system, , azimuth, , settings] = page.cards;
  it('weighs cards by their rows', () => {
    expect(weight(system)).toBe(2);
    expect(weight(azimuth)).toBe(1 + 3 + 10);
    // Closed: one row, however much it holds.
    expect(weight(settings)).toBe(1);
  });
  it('puts each card in the lightest column, in order', () => {
    const names = (cols: typeof page.cards[]) => cols.map((c) => c.map((s) => s.name));
    // The short card no longer leaves a gap beside the tall ones.
    expect(names(placeCards(page.cards, 2))).toEqual([
      ['system', 'azimuth', 'settings'],
      ['heliostat', 'elevation'],
    ]);
    expect(names(placeCards(page.cards, 3))).toEqual([['system', 'elevation'], ['heliostat', 'settings'], ['azimuth']]);
    expect(names(placeCards(page.cards, 1))).toEqual([page.cards.map((c) => c.name)]);
  });
});
