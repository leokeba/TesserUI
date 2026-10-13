// The launcher (DESIGN.md §9.7): launcher.js, a script of its own beside
// ui.js, which loads it on a page that no node served. Pages load it
// directly. It holds the workspace of §9.7.2, the connection screen's own
// ways and the flasher's button; a node's page never needs them.
import { mount } from 'svelte';
import { pageOptions } from '../page';
import Workspace from './Workspace.svelte';

document.body.style.margin = '0';
mount(Workspace, { target: document.body, props: { options: pageOptions() } });
