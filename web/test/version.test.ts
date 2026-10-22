import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// One version for the C++ library and the npm packages (DESIGN §12), set
// with `node scripts/version.mjs X.Y.Z`, which without one checks them.
describe('versions', () => {
  it('agree across the packages', () => {
    const script = new URL('../scripts/version.mjs', import.meta.url).pathname;
    expect(() => execFileSync('node', [script], { stdio: 'pipe' })).not.toThrow();
  });
});
