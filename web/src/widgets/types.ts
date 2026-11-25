import type { Leaf } from '../model/model';

export interface WidgetProps {
  leaf: Leaf;
  value: unknown;
  // drag: a slider or knob moving; writes are throttled (DESIGN.md §7.4).
  set: (value: unknown, drag?: boolean) => void;
  disabled: boolean;
  id: string;
}

// A detent at 0 (DESIGN.md §4): dragging a range that spans 0 snaps to
// exactly 0 within 2.5 % of its width, so a motor's output can be dragged
// back to a stop. Keys and typed values aren't snapped.
export function detent(v: number, min?: number, max?: number): number {
  return min !== undefined && max !== undefined && min < 0 && max > 0 && Math.abs(v) <= 0.025 * (max - min) ? 0 : v;
}

export const asNumber = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : NaN);

// Integers that don't fit a double are sent as BigInt, so they stay exact.
export function parseNumber(text: string, type: string): number | bigint | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (type === 'integer' && /^-?\d+$/.test(t) && !Number.isSafeInteger(Number(t))) return BigInt(t);
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export interface Span {
  min?: number;
  max?: number;
}

// A value's bounds, from ui.bounds when it has one (DESIGN.md §5.2): a
// number scales the schema's range to that magnitude (its limit), while an
// object {min, max} or a two-element array gives them as they are. The
// schema's own range is the fallback until the other value is known.
export function span(leaf: Leaf, get: (path: string) => unknown): Span {
  if (leaf.bounds) {
    const v = get(leaf.bounds);
    if (Array.isArray(v) && v.length >= 2) {
      const min = asNumber(v[0]);
      const max = asNumber(v[1]);
      if (!Number.isNaN(min) && !Number.isNaN(max)) return { min: Math.min(min, max), max: Math.max(min, max) };
    } else if (v !== null && typeof v === 'object') {
      const pair = v as { min?: unknown; max?: unknown };
      const min = asNumber(pair.min);
      const max = asNumber(pair.max);
      if (!Number.isNaN(min) && !Number.isNaN(max)) return { min: Math.min(min, max), max: Math.max(min, max) };
    } else {
      const n = asNumber(v);
      if (!Number.isNaN(n)) {
        const magnitude = Math.max(Math.abs(leaf.min ?? 0), Math.abs(leaf.max ?? 0));
        // A declared range keeps its shape (0..255 with 200 → 0..200,
        // -1000..1000 with 120 → -120..120); without one, it is symmetric.
        if (leaf.min !== undefined && leaf.max !== undefined && magnitude > 0) {
          const k = Math.abs(n) / magnitude;
          return { min: leaf.min * k, max: leaf.max * k };
        }
        return { min: -Math.abs(n), max: Math.abs(n) };
      }
    }
  }
  return { min: leaf.min, max: leaf.max };
}

// An input's step and bounds: the leaf's, but loose enough for the value
// the device holds (249 for a step of 5, 300 above a max of 255), which the
// input then shows as it is, without flagging it invalid.
export function bounds(leaf: Leaf, v: unknown, min = leaf.min, max = leaf.max): { min?: number; max?: number; step: number | 'any' } {
  const n = asNumber(v);
  const r = (n - (min ?? 0)) / (leaf.step ?? 1);
  return {
    min: min === undefined || n < min ? undefined : min,
    max: max === undefined || n > max ? undefined : max,
    step: leaf.step && (Number.isNaN(n) || Math.abs(r - Math.round(r)) < 1e-6) ? leaf.step : 'any',
  };
}

// A dragged value back on the leaf's step.
export const onStep = (v: number, leaf: Leaf, min = leaf.min) =>
  leaf.step ? Number(((min ?? 0) + Math.round((v - (min ?? 0)) / leaf.step) * leaf.step).toFixed(10)) : v;

export function fixed(v: unknown, precision: number | undefined): string {
  if (typeof v === 'bigint') return v.toString();
  const n = asNumber(v);
  if (Number.isNaN(n)) return '';
  return precision === undefined ? String(n) : n.toFixed(precision);
}
