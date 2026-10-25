// Paths within a files widget's tree (DESIGN.md §4.1): absolute, "/"
// separated, no trailing slash but the root's.

export interface Entry {
  name: string;
  size: number;
  dir: boolean;
  // Epoch seconds, 0 if unknown.
  modified: number;
}

export const join = (dir: string, name: string) => (dir === '/' ? '' : dir) + '/' + name;
export const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
export const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

// Each folder from the root to `p`, the root included.
export const ancestors = (p: string) => p.split('/').map((_, i, a) => a.slice(0, i + 1).join('/') || '/').slice(p === '/' ? 1 : 0);

// Folders first, then by name.
export const sorted = (entries: Entry[]) => [...entries].sort((a, b) => +b.dir - +a.dir || a.name.localeCompare(b.name));

// What a file opens as: text in the editor, an image in a preview,
// anything else downloads.
export const isText = (name: string) => /\.(txt|log|md|json|html?|css|js|csv|xml|ya?ml|ini|conf|cfg|svg|sh|py)$/i.test(name);
export const isImage = (name: string) => /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(name);
