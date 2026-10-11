// Golden models (DESIGN.md §11): the UI model each fixture gives, written to
// fixtures/<name>.model.json. They are the expected output of every
// renderer's model, the LVGL renderer's included: the renderers share the
// fixtures' inputs and these outputs, not code. `vitest -u` rewrites them
// after an intended change; CI fails when they differ.
import { describe, expect, it } from 'vitest';
import { stringify } from '../src/client/json';
import { buildMenu, type MenuEntry } from '../src/model/menu';
import { buildPage } from '../src/model/model';
import { schemaAt } from '../src/model/schema';
import { buildView, type ViewPage } from '../src/model/views';
import { fixture } from './fixtures';

// The model without the schema each leaf carries (it is the input).
function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== 'schema' && x !== undefined) out[k] = k === 'depth' && x === Infinity ? null : strip(x);
    return out;
  }
  return v;
}

describe('golden models', () => {
  for (const name of ['testfw', 'demo', 'motors']) {
    it(name, async () => {
      const f = fixture(name);
      const model: Record<string, unknown> = { page: buildPage(f.schema, '/') };
      // With the menu (DESIGN.md §6.3): the entries, and the page of each one
      // on this node (the start page shows its own values only).
      const menu = buildMenu(f.schema, '/', (f.views?.pages as ViewPage[]) ?? null);
      const pages: Record<string, unknown> = {};
      for (const e of menu.flatMap((e): MenuEntry[] => [e, ...(e.children ?? [])])) {
        const path = e.href?.slice(1);
        const s = path?.startsWith('/') ? schemaAt(f.schema, path) : undefined;
        if (path && s?.type === 'object') pages[path] = buildPage(s, path, '/', undefined, undefined, path === '/');
      }
      model.menu = menu;
      model.pages = pages;
      if (f.views) model.views = (f.views.pages as ViewPage[]).map((p) => ({ id: p.id, ...buildView(p, f.schema) }));
      const text = JSON.stringify(JSON.parse(stringify(strip(model))), null, 1) + '\n';
      await expect(text).toMatchFileSnapshot(`../../fixtures/${name}.model.json`);
    });
  }
});
