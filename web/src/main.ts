// The bundle a node serves (ui.js): one UI on the whole page.
import { mountUi } from './embed';
import { pageOptions } from './page';

const options = pageOptions();
document.body.style.margin = '0';
// A launcher is a script of its own, launcher.js, next to this one: several
// nodes at once, remembered (DESIGN.md §9.7.2). A node's page never loads it.
if (!options.launcher) mountUi(document.body, options);
else if (import.meta.env.DEV) import('./launcher/launcher');
else import(/* @vite-ignore */ new URL('launcher.js', (document.currentScript as HTMLScriptElement).src).href);
