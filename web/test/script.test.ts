import { describe, expect, it } from 'vitest';
import { nodeScript } from '../src/widgets/script';

describe('a node’s ui.script (DESIGN §9.8)', () => {
  it('resolves paths on the node', () => {
    expect(nodeScript('/ext/x.js', 'http://node/api')).toBe('http://node/ext/x.js');
    expect(nodeScript('ext/x.js', 'http://node/api')).toBe('http://node/ext/x.js');
    expect(nodeScript('/ext/x.js', 'http://node/v1/api')).toBe('http://node/v1/ext/x.js');
    expect(nodeScript('/ext/x.js', 'http://localhost:8091/n/192.168.1.59/api')).toBe('http://localhost:8091/n/192.168.1.59/ext/x.js');
    expect(nodeScript('x.js?v=2', 'http://node/api')).toBe('http://node/x.js?v=2');
    expect(nodeScript('/api.js', 'http://node/api')).toBe('http://node/api.js');
  });

  it('refuses URLs of their own', () => {
    for (const s of ['https://evil.example/x.js', 'HTTP://evil/x.js', '//evil.example/x.js', 'javascript:alert(1)', 'data:text/javascript,alert(1)', 'blob:http://node/1', 'ja\nvascript:alert(1)', '\\\\evil/x.js', '/\\evil/x.js'])
      expect(nodeScript(s, 'http://node/api'), s).toBeNull();
  });

  it('refuses paths outside the node’s folder or inside its API', () => {
    const bridge = 'http://localhost:8091/n/192.168.1.59/api';
    for (const s of ['../other/x.js', '/../../n/192.168.1.66/ext/x.js', '/%2e%2e/%2e%2e/n/x/ext/x.js', '/..%2f..%2fx.js', '/api/peers/p/files/blob', 'api/files/blob', '/api', '/api?view=schema'])
      expect(nodeScript(s, bridge), s).toBeNull();
    expect(nodeScript('/../x.js', 'http://node/v1/api')).toBeNull();
    expect(nodeScript('/api/x.js', 'http://node/api')).toBeNull();
  });
});
