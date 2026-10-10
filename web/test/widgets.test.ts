import { describe, expect, it } from 'vitest';
import { buildLeaf, buildPage } from '../src/model/model';
import type { Schema } from '../src/model/schema';
import { posixTz } from '../src/model/tz';

const leaf = (s: Schema, name = 'x') => buildLeaf(name, `/${name}`, s, '/', '/');

describe('files (DESIGN §4)', () => {
  it('are file widgets, without a value to read', () => {
    expect(leaf({ type: 'file', readable: true, writable: true, maxSize: 1024, contentType: 'application/json' })).toMatchObject({
      widget: 'file',
      editable: true,
      readable: true,
      maxSize: 1024,
      contentType: 'application/json',
    });
    expect(leaf({ type: 'file', readable: true })).toMatchObject({ widget: 'file', editable: false });
    // A page leaving out a mirrored remote node subscribes to its values by
    // name: files and actions aren't among them.
    const page = buildPage(
      { type: 'object', children: { a: { type: 'integer' }, f: { type: 'file', readable: true }, m: { type: 'remote', mirror: true } } },
      '/',
    );
    expect(page.keys).toBe('a');
  });
});

describe('warnings (DESIGN §5.2)', () => {
  it('style read-only values only', () => {
    expect(leaf({ type: 'string', ui: { style: 'warning' } }).style).toBe('warning');
    expect(leaf({ type: 'boolean', ui: { style: 'warning' } }).style).toBe('warning');
    expect(leaf({ type: 'string', writable: true, ui: { style: 'warning' } }).style).toBeUndefined();
    expect(leaf({ type: 'string', ui: { style: 'danger' } }).style).toBeUndefined();
  });
});

describe('flags and time zones (DESIGN §5.1)', () => {
  it('fit integers and strings', () => {
    expect(leaf({ type: 'integer', writable: true, ui: { widget: 'flags', labels: 'Mon,Tue' } }).widget).toBe('flags');
    expect(leaf({ type: 'integer', ui: { widget: 'flags' } }).widget).toBe('flags');
    expect(leaf({ type: 'string', writable: true, ui: { widget: 'flags' } }).widget).toBe('text');
    expect(leaf({ type: 'string', writable: true, ui: { widget: 'timezone' } }).widget).toBe('timezone');
    expect(leaf({ type: 'string', ui: { widget: 'timezone' } }).widget).toBe('readout');
  });
  it('turn IANA zones into POSIX TZ strings', () => {
    expect(posixTz('Europe/Paris', 2026)).toBe('<+01>-1<+02>,M3.5.0,M10.5.0/3');
    expect(posixTz('America/New_York', 2026)).toBe('<-05>5<-04>,M3.2.0,M11.1.0');
    expect(posixTz('Australia/Sydney', 2026)).toBe('<+10>-10<+11>,M10.1.0,M4.1.0/3');
    expect(posixTz('Asia/Kolkata', 2026)).toBe('<+0530>-5:30');
    expect(posixTz('UTC', 2026)).toBe('<+00>0');
  });
});

describe('arrays and keyed lists (DESIGN §4)', () => {
  it('are tables, or charts of the whole array', () => {
    const a = leaf({ type: 'array', writable: true, maxSize: 8, items: { type: 'integer', min: 0, max: 9 } });
    expect(a).toMatchObject({ widget: 'table', editable: true, maxSize: 8, fixed: false });
    expect(a.columns?.map((c) => [c.path, c.widget, c.editable])).toEqual([['', 'slider', true]]);
    const offsets = leaf({ type: 'array', fixed: true, maxSize: 128, items: { type: 'number', unit: '°' }, ui: { widget: 'chart' } });
    expect(offsets).toMatchObject({ widget: 'chart', type: 'number', unit: '°', fixed: true, editable: false });
    expect(offsets.history).toBeUndefined(); // nothing kept over time
    expect(leaf({ type: 'array', items: { type: 'string' }, ui: { widget: 'chart' } }).widget).toBe('table');
  });
  it('name keyed lists rows by their key', () => {
    const l = leaf({ type: 'list', key: 'ssid', maxSize: 5, items: { type: 'object', children: { ssid: { type: 'string', writable: true }, password: { type: 'string', writable: true, secret: true } } } });
    expect(l.key).toBe('ssid');
    expect(l.columns?.map((c) => [c.path, c.widget, c.secret ?? false])).toEqual([
      ['ssid', 'text', false],
      ['password', 'password', true],
    ]);
  });
});
