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

export function fixed(v: unknown, precision: number | undefined): string {
  if (typeof v === 'bigint') return v.toString();
  const n = asNumber(v);
  if (Number.isNaN(n)) return '';
  return precision === undefined ? String(n) : n.toFixed(precision);
}
