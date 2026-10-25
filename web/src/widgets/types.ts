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
export function detent(v: number, leaf: Leaf): number {
  const { min, max } = leaf;
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

// An input's step and bounds: the leaf's, but loose enough for the value
// the device holds (249 for a step of 5, 300 above a max of 255), which the
// input then shows as it is, without flagging it invalid.
export function bounds(leaf: Leaf, v: unknown): { min?: number; max?: number; step: number | 'any' } {
  const n = asNumber(v);
  const r = (n - (leaf.min ?? 0)) / (leaf.step ?? 1);
  return {
    min: n < leaf.min! ? undefined : leaf.min,
    max: n > leaf.max! ? undefined : leaf.max,
    step: leaf.step && (Number.isNaN(n) || Math.abs(r - Math.round(r)) < 1e-6) ? leaf.step : 'any',
  };
}

// A dragged value back on the leaf's step.
export const onStep = (v: number, leaf: Leaf) => (leaf.step ? Number(((leaf.min ?? 0) + Math.round((v - (leaf.min ?? 0)) / leaf.step) * leaf.step).toFixed(10)) : v);

export function fixed(v: unknown, precision: number | undefined): string {
  if (typeof v === 'bigint') return v.toString();
  const n = asNumber(v);
  if (Number.isNaN(n)) return '';
  return precision === undefined ? String(n) : n.toFixed(precision);
}
