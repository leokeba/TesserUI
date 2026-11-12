import { afterEach, describe, expect, it, vi } from 'vitest';
import { restart } from '../src/flash/esp';
import type { Board } from '../src/flash/esp';
import type { Transport } from 'esptool-js';

afterEach(() => vi.useRealTimers());

describe('the flasher’s post-reset serial port', () => {
  it('keeps the port open briefly after releasing reset', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const transport = {
      setDTR: async (value: boolean) => void calls.push(`dtr:${value}`),
      setRTS: async (value: boolean) => void calls.push(`rts:${value}`),
      disconnect: async () => void calls.push('close'),
    } as unknown as Transport;
    const board = { transport } as Board;
    let done = false;
    const result = restart(board).then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(calls).toEqual(['dtr:false', 'rts:true']);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['dtr:false', 'rts:true', 'rts:false']);
    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(calls).toEqual(['dtr:false', 'rts:true', 'rts:false', 'close']);
  });
});
