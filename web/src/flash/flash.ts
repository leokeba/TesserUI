// flash.js: the flasher, which a launcher loads when the user asks for it
// (DESIGN.md §9.7.1). Built apart from ui.js (`vite build --mode flash`), so
// esptool-js never reaches a node's bundle.
import { mount as svelteMount, unmount } from 'svelte';
import Flasher from './Flasher.svelte';

export function mount(target: HTMLElement, props: Parameters<typeof Flasher>[1]): () => void {
  const app = svelteMount(Flasher, { target, props });
  return () => unmount(app);
}
