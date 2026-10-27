// Minifies the CSS Svelte injects (css: 'injected'): it keeps the rules'
// own spacing, "0.5em", "#ffffff" and the last ";" in its template strings,
// which the JavaScript minifier leaves alone. lightningcss rewrites each
// component's `$$css.code` as it leaves the Svelte plugin.

import { transform } from 'lightningcss';
import { parseAst } from 'vite';

export function minifyCss() {
  return {
    name: 'tesserui-css',
    enforce: 'post',
    transform(code, id) {
      if (!/\.svelte(\?|$)/.test(id) || !code.includes('$$css')) return null;
      const edits = [];
      for (const n of parseAst(code).body) {
        const d = n.type === 'VariableDeclaration' ? n.declarations[0] : null;
        if (d?.id.name !== '$$css' || d.init?.type !== 'ObjectExpression') continue;
        const css = d.init.properties.find((p) => p.key?.name === 'code')?.value;
        if (css?.type !== 'Literal' || typeof css.value !== 'string') throw new Error(`css: no $$css.code in ${id}`);
        const out = transform({ filename: id, code: Buffer.from(css.value), minify: true }).code.toString();
        edits.push([css.start, css.end, JSON.stringify(out)]);
      }
      if (!edits.length) return null;
      let out = code;
      for (const [start, end, text] of edits.reverse()) out = out.slice(0, start) + text + out.slice(end);
      return { code: out, map: null };
    },
  };
}
