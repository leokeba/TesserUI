import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { md5 } from '../src/flash/md5';

describe('md5', () => {
  it('matches the reference at every padding boundary', () => {
    for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 4096 + 7]) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 131 + n) & 255);
      expect(md5(data), `${n} bytes`).toBe(createHash('md5').update(data).digest('hex'));
    }
  });

  it('matches on an image-sized buffer', () => {
    const data = new Uint8Array(1 << 21).map((_, i) => (i * 2654435761) >>> 24);
    expect(md5(data)).toBe(createHash('md5').update(data).digest('hex'));
  });
});
