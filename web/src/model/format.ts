// Labels and value formatting (DESIGN.md §4, §5.2).

import { stringify } from '../client/json';

// brightnessMax → "Brightness max", pid_kp → "Pid kp", HTTPPort → "HTTP port".
export function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .map((w) => (w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase()));
  const s = words.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function decimalsOf(step: number | undefined): number | undefined {
  if (!step) return undefined;
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

export interface NumberFormat {
  type: string;
  precision?: number;
  format?: string;
  unit?: string;
}

// The decimal separator of the browser's language, which native number
// inputs show ("0,25"): readouts use it too. A dot outside a browser (tests).
const DECIMAL = typeof document === 'undefined' ? '.' : (1.5).toLocaleString().charAt(1);
const decimal = (text: string) => (DECIMAL === '.' ? text : text.replace('.', DECIMAL));

// The number as text: printf-style `format`, else `precision` decimals, else
// integers as they are and numbers with up to 3 decimals.
export function formatValue(v: unknown, f: NumberFormat): string {
  if (v === undefined) return '–';
  if (v === null) return 'null';
  if (f.format) return printf(f.format, v);
  let text: string;
  if (typeof v === 'number' && Number.isInteger(v) && (f.unit === 'B' || f.unit === 's')) {
    return f.unit === 'B' ? bytes(v) : duration(v);
  }
  if (typeof v === 'number') {
    if (f.precision !== undefined) text = decimal(v.toFixed(f.precision));
    else if (f.type === 'integer' || Number.isInteger(v)) text = String(v);
    else text = decimal(String(Number(v.toFixed(3))));
  } else if (typeof v === 'bigint' || typeof v === 'string' || typeof v === 'boolean') {
    text = String(v);
  } else {
    text = stringify(v);
  }
  return f.unit ? `${text} ${f.unit}` : text;
}

// A chart's vertical axis (DESIGN.md §7.7): the values' extent, at least ten
// steps of the displayed precision wide so noise in the last digit stays
// small, and kept within the value's range (min, max) when it has one.
export function chartRange(values: number[], f: { min?: number; max?: number; precision?: number }): [number, number] {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const span = f.precision === undefined ? (hi > lo ? 0 : 2) : 10 ** (1 - f.precision);
  if (hi - lo < span) {
    lo -= (span - (hi - lo)) / 2;
    hi = lo + span;
  }
  if (f.min !== undefined && lo < f.min) (hi += f.min - lo), (lo = f.min);
  if (f.max !== undefined && hi > f.max) (lo -= hi - f.max), (hi = f.max);
  return [Math.max(lo, f.min ?? lo), hi];
}

// 1536 → "1.5 KB", 2031616 → "1.94 MB".
export function bytes(n: number): string {
  if (Math.abs(n) < 1024) return `${n} B`;
  return decimal(Math.abs(n) < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
}

// 59 → "59 s", 3725 → "1 h 2 min", 90061 → "1 d 1 h".
export function duration(n: number): string {
  const units: [number, string][] = [[86400, 'd'], [3600, 'h'], [60, 'min'], [1, 's']];
  const i = units.findIndex(([u]) => Math.abs(n) >= u);
  if (i < 0 || i === 3) return `${n} s`;
  const [u, name] = units[i];
  const [u2, name2] = units[i + 1];
  const rest = Math.floor((n % u) / u2);
  return `${Math.floor(n / u)} ${name}` + (rest ? ` ${rest} ${name2}` : '');
}

// printf subset: %d %i %u %f %.Nf %e %g %s %% (with an optional precision).
export function printf(format: string, v: unknown): string {
  return format.replace(/%(\.(\d+))?([diufegs%])/g, (_m, _p, prec: string | undefined, conv: string) => {
    if (conv === '%') return '%';
    const n = typeof v === 'bigint' ? Number(v) : Number(v);
    const p = prec === undefined ? undefined : Number(prec);
    switch (conv) {
      case 'd':
      case 'i':
        return typeof v === 'bigint' ? v.toString() : String(Math.trunc(n));
      case 'u':
        return typeof v === 'bigint' ? v.toString() : String(Math.trunc(n) >>> 0);
      case 'f':
        return decimal(n.toFixed(p ?? 6));
      case 'e':
        return decimal(n.toExponential(p ?? 6).replace(/e([+-])(\d)$/, 'e$10$2'));
      case 'g':
        return decimal(String(Number(n.toPrecision(p || 6))));
      default:
        return typeof v === 'string' ? v : String(v);
    }
  });
}
