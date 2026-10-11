// Notifications that have no place on screen (DESIGN.md §7.8): errors for
// paths not shown, events marked ui.toast, connection and sign-in news.
// One queue per UI.

import type { ToastKind } from '../model/model';
import { isUnder } from '../model/schema';

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  // The path an error is about: its label links to its page.
  path?: string;
  // How many times it came, while shown.
  count: number;
}

// Milliseconds on screen; errors stay until dismissed or cleared.
const DURATION: Record<ToastKind, number> = { info: 3000, ok: 3000, warn: 6000, error: 0 };
const MAX = 3;

export class Toasts {
  list: Toast[] = $state([]);
  private id = 0;
  private timers = new Map<number, { left: number; at: number; h?: ReturnType<typeof setTimeout> }>();
  // Why the timers are paused: pointer or focus on the toasts, a hidden tab.
  private holds = new Set<string>();

  show(text: string, kind: ToastKind = 'info', path?: string): number {
    let t = this.list.find((x) => x.kind === kind && x.text === text && x.path === path);
    if (t) t.count++;
    else {
      this.list.push({ id: ++this.id, kind, text, path, count: 1 });
      t = this.list[this.list.length - 1];
      // The oldest goes first, errors last, the new one never.
      while (this.list.length > MAX) this.dismiss((this.list.slice(0, -1).find((x) => x.kind !== 'error') ?? this.list[0]).id);
    }
    this.arm(t.id, DURATION[kind]);
    return t.id;
  }

  dismiss(id: number) {
    clearTimeout(this.timers.get(id)?.h);
    this.timers.delete(id);
    this.list = this.list.filter((t) => t.id !== id);
  }

  // A successful write or call clears the errors at and below its path.
  clear(path: string) {
    for (const t of this.list) if (t.path && isUnder(t.path, path)) this.dismiss(t.id);
  }

  hold(reason: string, on: boolean) {
    const was = this.holds.size;
    if (on) this.holds.add(reason);
    else this.holds.delete(reason);
    if (!was && this.holds.size) {
      for (const t of this.timers.values()) {
        clearTimeout(t.h);
        t.left -= Date.now() - t.at;
      }
    } else if (was && !this.holds.size) {
      // A second at least, to finish reading.
      for (const [id, t] of this.timers) this.run(id, t, Math.max(t.left, 1000));
    }
  }

  private arm(id: number, ms: number) {
    clearTimeout(this.timers.get(id)?.h);
    this.timers.delete(id);
    if (!ms) return;
    const t = { left: ms, at: 0 };
    this.timers.set(id, t);
    if (!this.holds.size) this.run(id, t, ms);
  }

  private run(id: number, t: { left: number; at: number; h?: ReturnType<typeof setTimeout> }, ms: number) {
    t.left = ms;
    t.at = Date.now();
    t.h = setTimeout(() => this.dismiss(id), ms);
  }
}
