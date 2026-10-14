// A node's own script for its custom element (ui.script, DESIGN.md §9.8),
// as a URL to load, or null when refused. It runs on the page's origin, so a
// node (or a peer behind it) names only a path on the node: relative to its
// API, or from the folder above it, never a URL of its own (a scheme, `//`),
// never outside that folder, nor inside the API, whose answers a peer may
// shape. `%` and `\` are refused too: a server may decode them into what the
// check didn't see. Absolute URLs come only from the page's config.scripts.
export function nodeScript(script: string, api: string): string | null {
  if (/^[a-z][a-z\d+.-]*:|^\/\/|[%\\]/i.test(script)) return null;
  const root = new URL('.', api);
  const url = new URL(script[0] === '/' ? '.' + script : script, root);
  const inApi = (url.pathname + '/').startsWith(new URL(api).pathname.replace(/\/?$/, '/'));
  return url.origin === root.origin && url.pathname.startsWith(root.pathname) && !inApi ? url.href : null;
}
