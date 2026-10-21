// The demo and motors fixtures, generated through real TesserAPI by
// test/fixtures_main.cpp: every widget and hint of DESIGN §4 and §5.
import { describe, expect, it } from 'vitest';
import { buildLeaf, buildPage, type Item, type Leaf, type LinkItem, type Section } from '../src/model/model';
import { mergeSchema, type Schema } from '../src/model/schema';
import { buildView, viewModelItems, type ViewPage } from '../src/model/views';
import { fixture } from './fixtures';

const demo = fixture('demo');
const page = buildPage(demo.schema, '/');

function find(path: string): Item {
  let found: Item | undefined;
  const walk = (items: Item[]) => {
    for (const i of items) {
      if (i.path === path) found = i;
      if (i.kind === 'section') walk([...i.items, ...i.advancedItems]);
    }
  };
  walk(page.cards);
  if (!found) throw new Error(`no item at ${path}`);
  return found;
}
const leaf = (p: string) => find(p) as Leaf;
const sec = (p: string) => find(p) as Section;

describe('demo: widgets', () => {
  it('draws an object with a custom element (DESIGN §9.8)', () => {
    expect(leaf('/sky')).toMatchObject({ kind: 'leaf', type: 'object', widget: 'x-sun-dial', script: '/ext/sun-dial.js', editable: false });
    // The element may read anything below its object: no depth limit.
    expect(page.depth).toBe(Infinity);
  });
  it('covers every widget', () => {
    const widgets = new Set<string>();
    const walk = (items: Item[]) => {
      for (const i of items) {
        if (i.kind === 'leaf') widgets.add(i.widget).add(i.field ?? 'button');
        if (i.kind === 'link') widgets.add('link');
        if (i.kind === 'section') walk([...i.items, ...i.advancedItems]);
      }
    };
    walk(page.cards);
    for (const w of ['toggle', 'checkbox', 'led', 'slider', 'knob', 'number', 'stepper', 'readout', 'bar', 'gauge', 'chart', 'segmented', 'select', 'radio', 'text', 'password', 'textarea', 'color', 'button', 'hold', 'json', 'events', 'table', 'link']) {
      expect(widgets, w).toContain(w);
    }
  });
  it('maps the lamp', () => {
    expect(leaf('/lamp/brightness')).toMatchObject({ widget: 'slider', step: 5, precision: 0 });
    expect(leaf('/lamp/color').widget).toBe('color');
    expect(leaf('/lamp/mode')).toMatchObject({ widget: 'segmented', options: [{ label: 'Off' }, { label: 'Automatic' }, { label: 'Manual' }] });
    expect(leaf('/lamp/effect').widget).toBe('select');
    expect(leaf('/lamp/power')).toMatchObject({ widget: 'gauge', unit: 'W', editable: false });
    expect(leaf('/lamp/name')).toMatchObject({ widget: 'text', maxLength: 15, placeholder: 'Lamp name' });
    expect(leaf('/lamp/preset')).toMatchObject({ widget: 'button', value: 3, label: 'Preset 3' });
    expect(sec('/lamp').icon).toBe('bulb');
  });
  it('maps the motor', () => {
    expect(leaf('/motor/speed')).toMatchObject({ widget: 'knob', precision: 2 });
    expect(leaf('/motor/duty')).toMatchObject({ widget: 'stepper', unit: '%' });
    expect(leaf('/motor/position')).toMatchObject({ widget: 'chart', history: 30 });
    expect(leaf('/motor/jog').widget).toBe('hold');
    expect(leaf('/motor/moveTo')).toMatchObject({ field: 'slider', confirm: 'Move the mirror?', min: 0, max: 360 });
    expect(leaf('/motor/stop')).toMatchObject({ style: 'danger', icon: 'stop' });
    expect(leaf('/motor/home')).toMatchObject({ widget: 'button', deferred: true });
    expect(sec('/motor').advancedItems.map((i) => i.name)).toEqual(['pid']);
  });
  it('maps sensors, forms and conditions', () => {
    expect(leaf('/sensors/temperature').precision).toBe(1);
    expect(leaf('/sensors/pressure').format).toBe('%.0f hPa');
    expect(leaf('/sensors/pressed')).toMatchObject({ widget: 'events' });
    expect(leaf('/sensors/pressed').toast).toBeUndefined();
    expect(leaf('/motor/homed')).toMatchObject({ widget: 'events', toast: 'ok', hidden: true });
    expect(leaf('/sensors/raw')).toMatchObject({ widget: 'json', editable: true });
    expect(sec('/settings').form).toBe(true);
    expect(leaf('/settings/apply').submit).toBe(true);
    expect(leaf('/config/manualSpeed').visibleWhen).toEqual([{ path: '/config/mode', equal: true, literal: 'manual' }]);
    expect(leaf('/config/threshold').enabledWhen).toEqual([{ path: '/config/enabled', equal: true, literal: 'true' }]);
    expect(leaf('/config/token').hidden).toBe(true);
    expect(leaf('/config/readonlyLevel')).toMatchObject({ widget: 'readout', editable: false });
    expect(leaf('/widgets/conditional').visibleWhen).toEqual([
      { path: '/config/enabled', equal: true, literal: 'true' },
      { path: '/config/mode', equal: false, literal: 'auto' },
    ]);
  });
  it('lays out sections (DESIGN §6.1)', () => {
    expect(page.columns).toBe(3);
    expect(page.cards[0]).toMatchObject({ label: '', items: [{ name: 'uptime' }, { name: 'online' }, { name: 'info', kind: 'link' }, { name: 'sky', kind: 'leaf', widget: 'x-sun-dial', script: '/ext/sun-dial.js' }, { name: 'sequence', kind: 'leaf', widget: 'x-keyframes' }, { name: 'blob' }, { name: '_ui', hidden: true }] });
    expect(sec('/config/network')).toMatchObject({ level: 2, collapsed: true });
    // Depth 3 from the root: the 4th level is fetched on opening.
    expect(sec('/config/network/deep')).toMatchObject({ level: 3, lazy: false });
    expect(sec('/config/network/deep/deeper')).toMatchObject({ level: 4 });
    expect(sec('/offset').inline).toBe(true);
    expect(sec('/channels').tabs).toBe(true);
    // A list directly under the page is a card of its own; one of more than
    // three columns opens element by element.
    expect(page.cards.find((c) => c.path === '/schedule')).toMatchObject({ label: 'Schedule', items: [{ name: 'schedule', widget: 'list', label: '' }] });
    const labels = page.cards.map((c) => c.label);
    expect(labels.indexOf('Pinned')).toBe(labels.indexOf('Widget overrides') + 1);
    const peers = sec('/peers');
    expect(peers.items).toMatchObject([
      { kind: 'link', name: 'heliostat-3', online: true },
      { kind: 'link', name: 'kitchen-lamp', online: false },
      { kind: 'link', name: 'porch-lamp', online: true },
    ]);
    expect((find('/info') as LinkItem).remote).toBe(false);
    expect(leaf('/schedule').columns?.map((c) => [c.name, c.editable])).toEqual([
      ['hour', true],
      ['enabled', true],
      ['label', true],
      ['runs', false],
    ]);
    expect(page.keys?.split(',')).not.toContain('info');
    expect(page.keys?.split(',')).toContain('peers');
  });
  it('renders what TesserKIT services declare', () => {
    expect(leaf('/settings/password')).toMatchObject({ widget: 'password', secret: true });
    expect(sec('/system').access).toBe('admin');
    expect(leaf('/system/days')).toMatchObject({ widget: 'flags', access: 'admin' });
    expect(leaf('/system/tz').widget).toBe('timezone');
    expect(leaf('/system/setClock')).toMatchObject({ widget: 'button', value: '$now' });
    expect(leaf('/system/scan')).toMatchObject({ field: 'text', deferred: true });
    expect(leaf('/account/login').params?.map((p) => [p.name, p.widget])).toEqual([
      ['name', 'text'],
      ['password', 'password'],
    ]);
    expect(find('/account/whoami')?.hidden).toBe(true);
    // Saved Wi-Fi networks: elements edited as forms (a list, not a table),
    // suggested by the scan, which the list draws instead of a button.
    expect(leaf('/system/wifi/networks')).toMatchObject({ widget: 'list', key: 'ssid', suggest: '/system/wifi/scan' });
    expect(leaf('/system/wifi/scan')).toMatchObject({ suggests: '/system/wifi/networks', hidden: false });
    expect(leaf('/tables/offsets')).toMatchObject({ widget: 'chart', unit: '°', fixed: true, editable: false });
    expect(leaf('/tables/gains')).toMatchObject({ widget: 'table', editable: true, maxSize: 6, fixed: false });
    expect(leaf('/tables/gains').columns?.[0]).toMatchObject({ widget: 'slider', min: 0, max: 100 });
    // Drawn by its element, the sky's action has no row: built on its own.
    const add = buildLeaf('addSource', '/sky/addSource', demo.schema.children!.sky.children!.addSource, '/sky', '/');
    expect(add.params?.map((p) => p.name)).toEqual(['name', 'azimuth', 'elevation']);
  });
});

describe('demo: views (DESIGN §8)', () => {
  const view = demo.views!.pages[0] as ViewPage;
  it('builds from the schema, waiting for peers', () => {
    const v = buildView(view, demo.schema);
    expect(v.items[0]).toMatchObject({ kind: 'row', items: [{ kind: 'node', item: { widget: 'gauge' } }, { kind: 'node', item: { widget: 'readout' } }] });
    // A card around one subtree is that subtree's card.
    expect(v.items[1]).toMatchObject({ kind: 'node', item: { kind: 'section', level: 1, label: 'Motor', path: '/motor' } });
    // A wide card around a custom element, without the node's label.
    expect(v.items[2]).toMatchObject({ kind: 'card', label: 'Sequence', wide: true, items: [{ item: { widget: 'x-keyframes', label: '' } }] });
    expect(v.items[3]).toEqual({ kind: 'text', text: 'Live values from **every** node.' });
    // `each` over the peers: their trees aren't fetched yet.
    expect(v.missing).toEqual(['/peers/heliostat-3/lamp/on', '/peers/kitchen-lamp/lamp/on', '/peers/porch-lamp/lamp/on']);
    // The element wants its whole subtree; of the root, only what it shows.
    expect(v.specs).toEqual([{ path: '/', keys: 'lamp,sensors,motor,sequence', depth: undefined }]);
    expect(viewModelItems(v.items).map((i) => i.path)).toEqual(['/lamp/power', '/sensors/temperature', '/motor', '/sequence']);
  });
  it('labels repeated items with the peer and subscribes per node', () => {
    const root = structuredClone(demo.schema) as Schema;
    const peer: Schema = { type: 'object', label: 'Heliostat 3', children: { lamp: { type: 'object', children: { on: { type: 'boolean', writable: true } } } } };
    mergeSchema(root, '/peers/heliostat-3', peer);
    const v = buildView(view, root);
    expect(v.items[4]).toMatchObject({ kind: 'node', item: { path: '/peers/heliostat-3/lamp/on', label: 'Heliostat 3', widget: 'toggle' } });
    expect(v.specs).toContainEqual({ path: '/peers/heliostat-3/lamp/on', depth: 0 });
  });
});

describe('demo: wide cards', () => {
  it('carries wide to cards and to a card around one subtree', () => {
    const page: ViewPage = {
      id: 'w',
      label: 'W',
      items: [
        { card: 'Lamp', items: [{ node: '/lamp/on' }, { node: '/lamp/brightness' }], wide: true },
        { card: 'Motor', items: [{ node: '/motor' }], wide: true },
        { card: 'Sky', items: [{ widget: 'x-sun-dial', path: '/sky' }] },
      ],
    };
    const v = buildView(page, demo.schema);
    expect(v.items[0]).toMatchObject({ kind: 'card', label: 'Lamp', wide: true });
    expect(v.items[1]).toMatchObject({ kind: 'node', item: { kind: 'section', label: 'Motor' }, wide: true });
    expect(v.items[2]).toMatchObject({ kind: 'card', label: 'Sky' });
    expect('wide' in v.items[2] && v.items[2].wide).toBeFalsy();
  });
});

describe('demo: custom pages', () => {
  it('a view of one custom element is a custom page', () => {
    const sky = demo.views!.pages.find((p) => (p as ViewPage).id === 'sky') as ViewPage;
    const v = buildView(sky, demo.schema);
    expect(v.items).toMatchObject([{ kind: 'node', item: { kind: 'leaf', widget: 'x-sun-dial', path: '/sky' } }]);
    expect(v.specs).toEqual([{ path: '/sky', depth: undefined }]);
  });
});

describe('motors: helionext ported with no hand-written UI', () => {
  const m = fixture('motors');
  const p = buildPage(m.schema, '/');
  it('renders both motors, the calibration form and the log file', () => {
    expect(p.cards.map((c) => c.label)).toEqual(['Azimuth motor', 'Elevation motor', 'Calibration', 'Diagnostics']);
    expect(p.cards[3].items[0]).toMatchObject({ path: '/diagnostics/log', widget: 'file', readable: true, editable: true });
    const az = p.cards[0];
    const control = az.items[0] as Section;
    expect(control.items.map((i) => (i as Leaf).label)).toEqual(['Speed', 'Duty cycle', 'Direction']);
    expect((control.items[0] as Leaf).widget).toBe('slider');
    expect(az.items.find((i) => i.name === 'config')).toMatchObject({ label: 'Settings', collapsed: true });
    expect(p.cards[2].form).toBe(true);
  });
});
