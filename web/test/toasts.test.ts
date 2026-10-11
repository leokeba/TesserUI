import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toasts } from '../src/store/toasts.svelte';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const texts = (t: Toasts) => t.list.map((x) => x.text);

describe('toasts (DESIGN §7.8)', () => {
  it('fades info after 3 s and warnings after 6 s; errors stay', () => {
    const t = new Toasts();
    t.show('saved', 'ok');
    t.show('hot', 'warn');
    t.show('broken', 'error');
    vi.advanceTimersByTime(3000);
    expect(texts(t)).toEqual(['hot', 'broken']);
    vi.advanceTimersByTime(3000);
    expect(texts(t)).toEqual(['broken']);
    vi.advanceTimersByTime(60000);
    expect(texts(t)).toEqual(['broken']);
    t.dismiss(t.list[0].id);
    expect(t.list).toEqual([]);
  });
  it('counts repeats instead of stacking them, and restarts their time', () => {
    const t = new Toasts();
    t.show('pressed');
    vi.advanceTimersByTime(2000);
    t.show('pressed');
    t.show('pressed', 'warn');
    expect(t.list.map((x) => [x.text, x.kind, x.count])).toEqual([
      ['pressed', 'info', 2],
      ['pressed', 'warn', 1],
    ]);
    vi.advanceTimersByTime(2000);
    expect(t.list.length).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(t.list.map((x) => x.kind)).toEqual(['warn']);
  });
  it('shows three at most: the oldest goes first, errors last, the new one never', () => {
    const t = new Toasts();
    t.show('e1', 'error');
    t.show('i1');
    t.show('e2', 'error');
    t.show('i2');
    expect(texts(t)).toEqual(['e1', 'e2', 'i2']);
    t.show('e3', 'error');
    expect(texts(t)).toEqual(['e1', 'e2', 'e3']);
    t.show('i3');
    expect(texts(t)).toEqual(['e2', 'e3', 'i3']);
  });
  it('waits while held, then leaves a second at least', () => {
    const t = new Toasts();
    t.show('a');
    vi.advanceTimersByTime(2500);
    t.hold('pointer', true);
    t.hold('hidden', true);
    t.show('b');
    vi.advanceTimersByTime(10000);
    t.hold('pointer', false);
    vi.advanceTimersByTime(10000);
    expect(texts(t)).toEqual(['a', 'b']);
    t.hold('hidden', false);
    vi.advanceTimersByTime(999);
    expect(texts(t)).toEqual(['a', 'b']);
    vi.advanceTimersByTime(1);
    expect(texts(t)).toEqual(['b']);
    vi.advanceTimersByTime(2000);
    expect(t.list).toEqual([]);
  });
  it('clears errors at and below a path', () => {
    const t = new Toasts();
    t.show('bad az', 'error', '/aim/az');
    t.show('bad', 'error', '/aim');
    t.show('other', 'error', '/aimer');
    t.clear('/aim/az');
    expect(texts(t)).toEqual(['bad', 'other']);
    t.show('bad az', 'error', '/aim/az');
    t.clear('/aim');
    expect(texts(t)).toEqual(['other']);
  });
});
