// A files widget's paths (DESIGN.md §4.1).
import { describe, expect, it } from 'vitest';
import { ancestors, isImage, isText, join, nameOf, parentOf, sorted } from '../src/widgets/files/paths';

describe('files: paths', () => {
  it('joins, splits and walks up', () => {
    expect(join('/', 'www')).toBe('/www');
    expect(join('/www', 'img')).toBe('/www/img');
    expect(parentOf('/www/img')).toBe('/www');
    expect(parentOf('/www')).toBe('/');
    expect(nameOf('/www/index.html')).toBe('index.html');
    expect(ancestors('/')).toEqual(['/']);
    expect(ancestors('/www/img')).toEqual(['/', '/www', '/www/img']);
  });
  it('lists folders first, then by name', () => {
    const e = (name: string, dir = false) => ({ name, dir, size: 0, modified: 0 });
    expect(sorted([e('b.txt'), e('z', true), e('a.txt'), e('c', true)]).map((x) => x.name)).toEqual(['c', 'z', 'a.txt', 'b.txt']);
  });
  it('opens text in the editor, images in a preview', () => {
    expect(isText('index.HTML')).toBe(true);
    expect(isText('settings.json')).toBe(true);
    expect(isText('blob.bin')).toBe(false);
    expect(isImage('logo.png')).toBe(true);
  });
});
