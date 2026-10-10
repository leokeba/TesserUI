// The bundle a node serves (ui.js): one UI on the whole page.
import { mountUi, type Options } from './embed';

// Configuration: window.TESSER from the page the node serves, overridable
// from the query string for development (?api=http://<ip>/api).
const q = new URLSearchParams(location.search);
const t = window.TESSER;
const options: Options = { ...t, api: q.get('api') ?? t?.api ?? '/api' };
if (q.has('ws')) options.ws = q.get('ws') || null;
else if (!t || !('ws' in t)) delete options.ws;
// On an HTTPS page that no node served (GitHub Pages), browsers block
// http:// and ws:// devices: Web Serial is the only transport (DESIGN.md §9.7).
const pages = !t && location.protocol === 'https:' && !q.has('api');
if (q.has('transport')) options.transport = q.get('transport') as Options['transport'];
else if (t?.serial || pages) options.transport = 'serial';

document.body.style.margin = '0';
mountUi(document.body, options);
