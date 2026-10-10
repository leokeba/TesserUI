import { mount } from 'svelte';
import App from './App.svelte';
import { app } from './shared.svelte';
import { Session, type Config } from './store/session.svelte';

// Configuration: window.TESSER from the page the node serves, overridable
// from the query string for development (?api=http://<ip>/api).
const q = new URLSearchParams(location.search);
const t = window.TESSER;
const api = q.get('api') ?? t?.api ?? '/api';
const ws = q.has('ws') ? q.get('ws') || null : t && 'ws' in t ? (t.ws ?? null) : new URL('/ws', new URL(api, location.href)).href;
// On an HTTPS page that no node served (GitHub Pages), browsers block
// http:// and ws:// devices: Web Serial is the only transport (DESIGN.md §9.7).
const pages = !t && location.protocol === 'https:' && !q.has('api');
const transport = (q.get('transport') ?? (t?.serial || pages ? 'serial' : ws ? 'ws' : 'http')) as Config['transport'];

app.session = new Session({ api, ws, transport, minVersion: t?.minVersion });
app.session.start();
mount(App, { target: document.body });
