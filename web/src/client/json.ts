// Lossless JSON. TesserAPI serves 64-bit integers, which JSON.parse would
// round: integers beyond 2^53 become BigInt, and are written back exactly.
// Uses JSON.parse source text access and JSON.rawJSON (ES2025).

type Reviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;

const revive: Reviver = (_key, value, context) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source)) {
    return BigInt(context.source);
  }
  return value;
};

export function parse(text: string): unknown {
  return JSON.parse(text, revive as (key: string, value: unknown) => unknown);
}

const rawJSON = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;

export function stringify(value: unknown, space?: number): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? (rawJSON ? rawJSON(v.toString()) : Number(v)) : v), space);
}

export type Json = null | boolean | number | bigint | string | Json[] | { [key: string]: Json };

export function isObject(v: unknown): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
