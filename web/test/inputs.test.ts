// The bounds of a value's inputs (W8): what the device holds is shown as it
// is, never flagged invalid, and a drag still writes values on the step.
import { describe, expect, it } from 'vitest';
import { buildLeaf } from '../src/model/model';
import { bounds, onStep } from '../src/widgets/types';

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
