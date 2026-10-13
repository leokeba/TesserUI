// One tab per device (DESIGN.md §9.7.2): a node a launcher reaches several
// ways (by its address, through the bridge, mounted by gateways) shows once.
// A connection to the node itself wins over a gateway mounting it, and the
// first connection or gateway over later ones.

// A connection, once loaded: its node's device id, and its remote nodes'
// paths with theirs (TesserAPI §14.1).
export interface Reach {
  id?: string;
  nodes: [string, string | undefined][];
}

// Each connection's tabs: '/' and the remote nodes it shows; [] when its
// node is another connection's; null while it isn't loaded.
export function onePerDevice(reach: (Reach | null)[]): (string[] | null)[] {
  const roots = new Set(reach.map((r) => r?.id).filter(Boolean));
  const seen = new Set<string>();
  return reach.map((r) => {
    if (!r) return null;
    if (r.id && seen.has(r.id)) return [];
    if (r.id) seen.add(r.id);
    const shown = r.nodes.filter(([, id]) => !id || (!roots.has(id) && !seen.has(id) && !!seen.add(id)));
    return ['/', ...shown.map(([p]) => p)];
  });
}
