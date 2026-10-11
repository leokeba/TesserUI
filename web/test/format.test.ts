import { describe, expect, it } from 'vitest';
import { chartRange, decimalsOf, formatValue, humanize, printf } from '../src/model/format';
import { holds, parseConditions, resolvePath } from '../src/model/conditions';
import { parse, stringify } from '../src/client/json';

describe('humanize', () => {
  it('splits names into words (DESIGN §4)', () => {
    expect(humanize('brightnessMax')).toBe('Brightness max');
    expect(humanize('pid_kp')).toBe('Pid kp');
    expect(humanize('uptimeMs')).toBe('Uptime ms');
    expect(humanize('HTTPPort')).toBe('HTTP port');
    expect(humanize('ch1')).toBe('Ch1');
    expect(humanize('tesser-f37c')).toBe('Tesser f37c');
  });
});

describe('formatting', () => {
  it('derives decimals from step', () => {
    expect(decimalsOf(0.01)).toBe(2);
    expect(decimalsOf(5)).toBe(0);
    expect(decimalsOf(1e-7)).toBe(7);
    expect(decimalsOf(undefined)).toBeUndefined();
  });
  it('formats numbers with unit and precision', () => {
    expect(formatValue(42, { type: 'integer', unit: '%' })).toBe('42 %');
    expect(formatValue(12.5, { type: 'number', unit: '°C', precision: 1 })).toBe('12.5 °C');
    expect(formatValue(0.123456, { type: 'number' })).toBe('0.123');
    expect(formatValue(2, { type: 'number' })).toBe('2');
    expect(formatValue(undefined, { type: 'number' })).toBe('–');
    expect(formatValue(18446744073709551615n, { type: 'integer' })).toBe('18446744073709551615');
  });
  it('implements the printf subset', () => {
    expect(printf('%.0f hPa', 1013.4)).toBe('1013 hPa');
    expect(printf('%d%%', 41.9)).toBe('41%');
    expect(printf('%.2e', 12345)).toBe('1.23e+04');
    expect(printf('%s!', 'hi')).toBe('hi!');
    expect(printf('%u', -1)).toBe('4294967295');
    expect(printf('%g', 0.5)).toBe('0.5');
  });
});

describe('lossless JSON', () => {
  it('keeps 64-bit integers exact', () => {
    const v = parse('{"big":-9007199254740993,"huge":18446744073709551615,"f":1.5,"e":1e300}') as Record<string, unknown>;
    expect(v.big).toBe(-9007199254740993n);
    expect(v.huge).toBe(18446744073709551615n);
    expect(v.f).toBe(1.5);
    expect(v.e).toBe(1e300);
    expect(stringify(v)).toBe('{"big":-9007199254740993,"huge":18446744073709551615,"f":1.5,"e":1e+300}');
  });
});

describe('conditions (DESIGN §5.3)', () => {
  const values: Record<string, unknown> = { '/config/mode': 'manual', '/config/enabled': true, '/config/n': 3, '/x': null };
  const get = (p: string) => values[p];
  it('resolves relative and absolute paths', () => {
    expect(resolvePath('mode', '/config')).toBe('/config/mode');
    expect(resolvePath('../config/enabled', '/lamp')).toBe('/config/enabled');
    expect(resolvePath('../dhcp', '/config/network/deep')).toBe('/config/network/dhcp');
    expect(resolvePath('/config/mode', '/a/b')).toBe('/config/mode');
    expect(resolvePath('/config/mode', '/peers/p/a', '/peers/p')).toBe('/peers/p/config/mode');
  });
  it('compares JSON text', () => {
    expect(holds(parseConditions('mode=manual', '/config'), get)).toBe(true);
    expect(holds(parseConditions('mode="manual"', '/config'), get)).toBe(true);
    expect(holds(parseConditions('mode!=manual', '/config'), get)).toBe(false);
    expect(holds(parseConditions('enabled=true&n=3', '/config'), get)).toBe(true);
    expect(holds(parseConditions('enabled=true&n!=3', '/config'), get)).toBe(false);
    expect(holds(parseConditions('/x=null', '/config'), get)).toBe(true);
  });
  it('fails on missing values', () => {
    expect(holds(parseConditions('missing=1', '/config'), get)).toBe(false);
    expect(holds(parseConditions('missing!=1', '/config'), get)).toBe(false);
  });
});

describe('chart axes (DESIGN §7.7)', () => {
  it('spans at least ten steps of the displayed precision', () => {
    // Encoder noise in the last digit stays a small ripple.
    const [lo, hi] = chartRange([34.15, 34.19], { precision: 2 });
    expect(hi - lo).toBeCloseTo(0.1);
    expect((lo + hi) / 2).toBeCloseTo(34.17);
    expect(chartRange([0, 50], { precision: 0 })).toEqual([0, 50]);
    expect(chartRange([5, 5], {})).toEqual([4, 6]);
    expect(chartRange([1, 3], {})).toEqual([1, 3]);
  });
  it('stays within the range instead of drawing all of it', () => {
    expect(chartRange([5.67, 5.67], { min: 0, max: 360, precision: 2 })[0]).toBeCloseTo(5.62);
    expect(chartRange([0, 0], { min: 0, max: 360, precision: 0 })).toEqual([0, 10]);
    expect(chartRange([360, 359], { min: 0, max: 360, precision: 0 })).toEqual([350, 360]);
    expect(chartRange([0.5, 0.5], { min: 0, max: 1, precision: 0 })).toEqual([0, 1]);
  });
});
