// The bundle a node serves (ui.js): one UI on the whole page.
import { mountUi, type Options } from './embed';

// Configuration: window.TESSER from the page the node serves, overridable
// from the query string for development (?api=http://<ip>/api).
const q = new URLSearchParams(location.search);
const t = window.TESSER;
// A page that no node served (GitHub Pages, the dev server) is a launcher:
// it connects to ?api=, or to the node the user picks (DESIGN.md §9.7).
const launcher = !t;
const options: Options = { ...t, api: q.get('api') ?? t?.api ?? '/api', launcher };
if (q.has('ws')) options.ws = q.get('ws') || null;
else if (!t || !('ws' in t)) delete options.ws;
if (q.has('transport')) options.transport = q.get('transport') as Options['transport'];
else if (t?.serial || (launcher && !q.has('api'))) options.transport = 'serial';

document.body.style.margin = '0';
mountUi(document.body, options);
