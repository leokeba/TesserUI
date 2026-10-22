// The node's bundle as a classic script with chunks beside it (DESIGN.md
// §9.4). Pages load ui.js with a plain <script src>, stubs on devices in the
// field included, so it can't be an ES module, yet the widgets few pages use
// come from ES chunks loaded on demand (widgets/registry.svelte.ts).
//
// The build puts every module the entry loads into one chunk, core, and
// those widgets into another (vite.config.ts). This plugin then makes core
// ui.js: wrapped in a function, its exports given to the chunks on a global,
// GLOBAL, and its import()s resolved from ui.js's own URL. A chunk's imports
// from core become a read of that global; its imports from other chunks stay.

import { posix } from 'node:path';
import { parseAst } from 'vite';

const GLOBAL = '__tesserui';

const BASE = '__tesseruiChunks';

// The code with each [start, end, text] replacement made.
function splice(code, edits) {
  let out = '';
  let at = 0;
  for (const [start, end, text] of edits.sort((a, b) => a[0] - b[0])) {
    out += code.slice(at, start) + text;
    at = end;
  }
  return out + code.slice(at);
}

// Every node of an ESTree, depth first.
function* walk(node) {
  if (!node || typeof node.type !== 'string') return;
  yield node;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const v of value) yield* walk(v);
    else if (value && typeof value === 'object') yield* walk(value);
  }
}

// The names a pattern binds.
function bound(p, out = []) {
  if (!p) return out;
  if (p.type === 'Identifier') out.push(p.name);
  else if (p.type === 'AssignmentPattern') bound(p.left, out);
  else if (p.type === 'RestElement') bound(p.argument, out);
  else if (p.type === 'ArrayPattern') for (const e of p.elements) bound(e, out);
  else if (p.type === 'ObjectPattern') for (const q of p.properties) bound(q.type === 'RestElement' ? q : q.value, out);
  return out;
}

const isFunction = (n) => /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type);

// The let, const, class and function declarations of a list of statements.
function lexical(statements) {
  const out = [];
  for (const s of statements) {
    const d = s.type.startsWith('Export') && s.declaration ? s.declaration : s;
    if (d.type === 'VariableDeclaration' && d.kind !== 'var') for (const v of d.declarations) bound(v.id, out);
    if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) out.push(d.id.name);
  }
  return out;
}

// The var declarations of a function's body, outside nested functions.
function vars(node, out = []) {
  for (const n of [node].flat()) {
    if (!n || typeof n.type !== 'string' || isFunction(n)) continue;
    if (n.type === 'VariableDeclaration' && n.kind === 'var') for (const v of n.declarations) bound(v.id, out);
    for (const value of Object.values(n)) if (value && typeof value === 'object') vars(value, out);
  }
  return out;
}

// Exported top-level names assigned anywhere their own binding is in scope:
// chunks would read a copy taken when they load.
function reassigned(code) {
  const ast = parseAst(code);
  const exported = new Set();
  for (const n of ast.body) {
    if (n.type === 'ExportNamedDeclaration' && !n.source) for (const s of n.specifiers) exported.add(s.local.name);
  }
  const found = new Set();
  const visit = (n, shadowed) => {
    if (!n || typeof n.type !== 'string') return;
    let inner = shadowed;
    const shadow = (names) => (inner = new Set([...inner, ...names.filter((x) => exported.has(x))]));
    if (isFunction(n)) shadow([...n.params.flatMap((p) => bound(p)), ...(n.id && n.type !== 'FunctionDeclaration' ? [n.id.name] : []), ...vars(n.body), ...(n.body.type === 'BlockStatement' ? lexical(n.body.body) : [])]);
    else if (n.type === 'BlockStatement' || n.type === 'StaticBlock') shadow(lexical(n.body));
    else if (n.type === 'SwitchStatement') shadow(lexical(n.cases.flatMap((c) => c.consequent)));
    else if (/^For(In|Of)?Statement$/.test(n.type)) shadow(lexical([n.init ?? n.left].filter((x) => x?.type === 'VariableDeclaration')));
    else if (n.type === 'CatchClause') shadow(bound(n.param));
    else if (n.type === 'ClassExpression' && n.id) shadow([n.id.name]);
    const target = n.type === 'AssignmentExpression' ? n.left : n.type === 'UpdateExpression' ? n.argument : null;
    for (const name of bound(target)) if (exported.has(name) && !inner.has(name)) found.add(name);
    for (const value of Object.values(n)) {
      if (Array.isArray(value)) for (const v of value) visit(v, inner);
      else if (value && typeof value === 'object') visit(value, inner);
    }
  };
  visit(ast, new Set());
  return [...found];
}

function linkCore(code, dir, entry) {
  if (code.includes(BASE)) throw new Error(`chunks: ${BASE} is used by the bundle`);
  const ast = parseAst(code);
  const edits = [];
  const exported = new Map();
  for (const n of ast.body) {
    if (n.type === 'ImportDeclaration') throw new Error('chunks: the core chunk imports another chunk');
    if (n.type === 'ExportNamedDeclaration' && !n.declaration && !n.source) {
      for (const s of n.specifiers) exported.set(s.exported.name, s.local.name);
      edits.push([n.start, n.end, `self.${GLOBAL}={${[...exported].map(([e, l]) => (e === l ? e : `${e}:${l}`)).join(',')}};`]);
    } else if (n.type.startsWith('Export')) {
      throw new Error(`chunks: unexpected ${n.type} in the core chunk`);
    }
  }
  for (const n of walk(ast)) {
    if (n.type === 'MetaProperty') throw new Error('chunks: import.meta in a classic script');
    if (n.type !== 'ImportExpression') continue;
    const s = n.source;
    const path = s.type === 'Literal' ? s.value : s.type === 'TemplateLiteral' && !s.expressions.length ? s.quasis[0].value.cooked : null;
    // Chunks, relative to core's own directory; anything else (launcher.js)
    // is the code's own business.
    if (typeof path === 'string' && path.startsWith('./')) {
      edits.push([s.start, s.end, `new URL(${JSON.stringify(path.slice(2))},${BASE}).href`]);
    }
  }
  // A source map's comment goes last, after the wrapper.
  const map = /\n\/\/# sourceMappingURL=\S+\s*$/.exec(code);
  if (map) edits.push([map.index, code.length, '']);
  return (
    `(()=>{"use strict";var ${BASE}=new URL(${JSON.stringify(dir)},document.currentScript?.src??location.href);\n` +
    splice(code, edits) +
    '\n})();\n' +
    (map ? `//# sourceMappingURL=${entry}.map\n` : '')
  );
}

function linkChunk(code, core) {
  const ast = parseAst(code);
  const edits = [];
  for (const n of ast.body) {
    if (n.type !== 'ImportDeclaration' || n.source.value !== `./${core}`) continue;
    const names = n.specifiers.map((s) => {
      if (s.type !== 'ImportSpecifier') throw new Error(`chunks: ${s.type} from the core chunk`);
      return s.imported.name === s.local.name ? s.local.name : `${s.imported.name}:${s.local.name}`;
    });
    edits.push([n.start, n.end, names.length ? `const{${names.join(',')}}=self.${GLOBAL};` : '']);
  }
  return splice(code, edits);
}

// The plugin, for the build of ui.js: `entry` is its file name, `core` the
// name of the group holding the modules it loads.
export function classicEntry({ entry = 'ui.js', core = 'core' } = {}) {
  return {
    name: 'tesserui-chunks',
    renderChunk(code, chunk) {
      if (chunk.name !== core) return null;
      const mutable = reassigned(code);
      if (mutable.length) throw new Error(`chunks: chunks would read a copy of ${mutable.join(', ')}, which change`);
      return null;
    },
    generateBundle(_, bundle) {
      const facade = bundle[entry];
      const coreFile = Object.keys(bundle).find((f) => bundle[f].type === 'chunk' && bundle[f].name === core);
      if (!facade || !coreFile) throw new Error(`chunks: no ${entry} or ${core} chunk`);
      const slash = coreFile.lastIndexOf('/');
      const dir = coreFile.slice(0, slash + 1);
      const coreName = coreFile.slice(slash + 1);
      // The entry only loads core: its own code is in core.
      if (facade.code.replace(/import\s*["'][^"']+["'];?/, '').trim()) throw new Error(`chunks: ${entry} holds code of its own`);
      facade.code = linkCore(bundle[coreFile].code, dir, entry);
      facade.map = null;
      delete bundle[coreFile];
      // core's source map, for ui.js: a line down for the wrapper, its
      // sources from ui.js's directory. Columns after an edit on the same
      // line are off by the edit's length, which size reports can bear.
      const map = bundle[`${coreFile}.map`];
      if (map) {
        const m = JSON.parse(map.source);
        m.file = entry;
        m.sources = m.sources.map((s) => posix.relative(posix.dirname(entry), posix.join(dir, s)));
        m.mappings = ';' + m.mappings;
        delete bundle[`${coreFile}.map`];
        this.emitFile({ type: 'asset', fileName: `${entry}.map`, source: JSON.stringify(m) });
      }
      for (const [file, out] of Object.entries(bundle)) {
        if (out.type !== 'chunk' || file === entry) continue;
        if (!file.startsWith(dir)) throw new Error(`chunks: ${file} outside ${dir}`);
        out.code = linkChunk(out.code, coreName);
      }
    },
  };
}

// The plugin for the builds without chunks (the npm module, launcher.js):
// the registry's import()s of widgets become static imports, which the
// bundler shakes as usual, where inlining import()s keeps whole modules.
export function staticWidgets() {
  return {
    name: 'tesserui-static-widgets',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/widgets/registry.svelte.ts')) return null;
      const imports = [];
      const out = code.replace(/import\((['"])(\.\/\w+\.svelte)\1\)/g, (_, q, path) => {
        imports.push(`import * as lazy${imports.length} from ${q}${path}${q};`);
        return `Promise.resolve(lazy${imports.length - 1})`;
      });
      if (!imports.length) throw new Error('chunks: no widget import() in the registry');
      return { code: imports.join('\n') + '\n' + out, map: null };
    },
  };
}
