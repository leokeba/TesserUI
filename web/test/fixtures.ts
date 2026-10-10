import { readFileSync, existsSync } from 'node:fs';
import { parse } from '../src/client/json';
import type { Schema } from '../src/model/schema';

export interface Fixture {
  source: string;
  schema: Schema;
  values: Record<string, unknown>;
  views?: { pages: unknown[] };
  peersSchema?: Schema;
}

const dir = new URL('../../fixtures/', import.meta.url);

export function fixture(name: string): Fixture {
  return parse(readFileSync(new URL(`${name}.json`, dir), 'utf8')) as Fixture;
}

export function hasFixture(name: string): boolean {
  return existsSync(new URL(`${name}.json`, dir));
}
