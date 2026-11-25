// The bounds of a value's inputs (W8): what the device holds is shown as it
// is, never flagged invalid, and a drag still writes values on the step.
import { describe, expect, it } from 'vitest';
import { buildLeaf } from '../src/model/model';
import type { Schema } from '../src/model/schema';
import { bounds, onStep, span } from '../src/widgets/types';

const brightness = buildLeaf('b', '/b', { type: 'integer', writable: true, min: 0, max: 255, step: 5 }, '/');

describe('input bounds', () => {
  it('keeps the step and range for a value on them', () => {
    expect(bounds(brightness, 250)).toEqual({ min: 0, max: 255, step: 5 });
    expect(bounds(brightness, undefined)).toEqual({ min: 0, max: 255, step: 5 });
  });
  it('loosens them for a value the device holds off them', () => {
    expect(bounds(brightness, 249).step).toBe('any');
    expect(bounds(brightness, 300)).toMatchObject({ min: 0, max: undefined });
  });
  it('puts a dragged value back on the step', () => {
    expect(onStep(251.55, brightness)).toBe(250);
    expect(onStep(0.3, buildLeaf('n', '/n', { type: 'number', writable: true, min: 0, max: 1 }, '/'))).toBe(0.3);
  });
});

describe('bounds that follow another value (DESIGN §5.2)', () => {
  const leaf = (s: Schema, path = '/motor/speed', parent = '/motor') => buildLeaf('speed', path, s, parent, '/');
  const at = (v: unknown) => () => v;

  it('scales a declared range to the other value, its limit', () => {
    const speed = leaf({ type: 'number', writable: true, min: -1000, max: 1000, ui: { bounds: 'limit' } });
    expect(speed.bounds).toBe('/motor/limit');
    expect(span(speed, at(120))).toEqual({ min: -120, max: 120 });
    expect(span(speed, at(60))).toEqual({ min: -60, max: 60 });
    // Until the other value is known, the schema's range stands.
    expect(span(speed, at(undefined))).toEqual({ min: -1000, max: 1000 });
    expect(span(speed, at(null))).toEqual({ min: -1000, max: 1000 });
  });

  it('keeps a one-sided range one-sided', () => {
    const ceiling = leaf({ type: 'number', writable: true, min: 0, max: 255, ui: { bounds: 'ceiling' } });
    expect(span(ceiling, at(200))).toEqual({ min: 0, max: 200 });
  });

  it('takes an object or an array as the bounds themselves', () => {
    const pair = leaf({ type: 'number', writable: true, min: 0, max: 1, ui: { bounds: 'range' } });
    expect(span(pair, at({ min: 0.25, max: 0.75 }))).toEqual({ min: 0.25, max: 0.75 });
    expect(span(pair, at([2, 4]))).toEqual({ min: 2, max: 4 });
    expect(span(pair, at([4, 2]))).toEqual({ min: 2, max: 4 });
  });

  it('does not follow a non-numeric value', () => {
    const speed = leaf({ type: 'number', writable: true, min: -1000, max: 1000, ui: { bounds: 'limit' } });
    expect(span(speed, at('fast'))).toEqual({ min: -1000, max: 1000 });
  });
});
