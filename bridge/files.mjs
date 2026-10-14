// A project's own files beside its launcher page (custom elements' scripts,
// images...), which the bridge serves at its root: `--file <name>=<path>`,
// or `--file <path>` under its base name. A name may have folders, never
// `.` or `..`, and never one of the bridge's own paths.

const own = /^(index\.html|ui\.js|launcher\.js|nodes|(flash|firmware|n|s)(\/.*)?)$/;

export function fileOption(arg) {
  const eq = arg.indexOf('=');
  const path = eq < 0 ? arg : arg.slice(eq + 1);
  const name = eq < 0 ? arg.split('/').pop() : arg.slice(0, eq);
  const segments = name.split('/');
  if (!path || !segments.every((s) => /^[\w.-]+$/.test(s) && s !== '.' && s !== '..')) throw new Error(`--file ${arg}: not a file name`);
  if (own.test(name)) throw new Error(`--file ${arg}: ${name} is the bridge's own`);
  return { name, path };
}

const types = {
  html: 'text/html',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  txt: 'text/plain',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
};

export const contentType = (name) => types[name.split('.').pop().toLowerCase()] ?? 'application/octet-stream';
