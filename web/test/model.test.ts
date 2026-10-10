import { describe, expect, it } from 'vitest';
import { buildLeaf, buildPage, depthOf, inferWidget, visiblePaths, type Leaf, type Section } from '../src/model/model';
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
