// The options of a UI that is the whole page: window.TESSER from the page
// the node serves, overridable from the query string for development
// (?api=http://<ip>/api). Shared by ui.js and the launcher's script.
import type { Options } from './embed';

export function pageOptions(): Options {
  const q = new URLSearchParams(location.search);
  const t = window.TESSER;
  // A page that no node served (GitHub Pages, the dev server) is a launcher:
  // it connects to ?api=, or to the nodes the user picks (DESIGN.md §9.7). A
  // page can be one with a configuration of its own: {launcher: true, title}.
  const launcher = !t || t.launcher === true;
  const options: Options = { ...t, api: q.get('api') ?? t?.api ?? '/api', launcher };
  if (q.has('ws')) options.ws = q.get('ws') || null;
  else if (!t || !('ws' in t)) delete options.ws;
  if (q.has('transport')) options.transport = q.get('transport') as Options['transport'];
  else if (t?.serial || (launcher && !q.has('api'))) options.transport = 'serial';
  return options;
}
