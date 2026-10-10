declare const __VERSION__: string;

interface Window {
  // The configuration a node's page provides (DESIGN.md §9.2).
  TESSER?: import('./embed').Options & { serial?: boolean };
}
