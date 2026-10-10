// Labels and value formatting (DESIGN.md §4, §5.2).

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

// The number as text: printf-style `format`, else `precision` decimals, else
// integers as they are and numbers with up to 3 decimals.
export function formatValue(v: unknown, f: NumberFormat): string {
  if (v === undefined) return '–';
  if (v === null) return 'null';
  if (f.format) return printf(f.format, v);
  let text: string;
  if (typeof v === 'number') {
    if (f.precision !== undefined) text = v.toFixed(f.precision);
    else if (f.type === 'integer' || Number.isInteger(v)) text = String(v);
    else text = String(Number(v.toFixed(3)));
  } else if (typeof v === 'bigint' || typeof v === 'string' || typeof v === 'boolean') {
    text = String(v);
  } else {
    text = JSON.stringify(v);
  }
  return f.unit ? `${text} ${f.unit}` : text;
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
        return n.toFixed(p ?? 6);
      case 'e':
        return n.toExponential(p ?? 6).replace(/e([+-])(\d)$/, 'e$10$2');
      case 'g':
        return String(Number(n.toPrecision(p || 6)));
      default:
        return typeof v === 'string' ? v : String(v);
    }
  });
}
