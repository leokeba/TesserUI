import { describe, expect, it } from 'vitest';
import { onePerDevice } from '../src/launcher/devices';

describe('one tab per device (DESIGN §9.7.2)', () => {
  // V3 and R1 mount each other, and both mount the Gledopto; the launcher
  // reaches V3 by its address, R1 through the bridge, then R1 again by USB.
  const v3 = { id: 'c8f09ef4a67c', nodes: [['/peers/r1', '10521c75f37c'], ['/peers/gledopto', 'aabbccddeeff']] as [string, string][] };
  const r1 = { id: '10521c75f37c', nodes: [['/peers/v3', 'c8f09ef4a67c'], ['/peers/gledopto', 'aabbccddeeff'], ['/peers/old', undefined]] as [string, string | undefined][] };
  it('prefers a connection to the node over a gateway, and the first gateway', () => {
    expect(onePerDevice([v3, r1])).toEqual([
      ['/', '/peers/gledopto'],
      ['/', '/peers/old'],
    ]);
  });
  it('shows a node reached twice once, and waits for what is loading', () => {
    expect(onePerDevice([v3, null, r1, r1])).toEqual([['/', '/peers/gledopto'], null, ['/', '/peers/old'], []]);
  });
  it('keeps nodes without ids', () => {
    expect(onePerDevice([{ nodes: [['/peers/a', undefined]] }, { nodes: [['/peers/a', undefined]] }])).toEqual([
      ['/', '/peers/a'],
      ['/', '/peers/a'],
    ]);
  });
});
