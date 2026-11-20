import { describe, expect, it } from 'vitest';
import { uiSvg, type CaptureNode } from './capture.ts';

const text = (t: string): CaptureNode => ({ nodeType: 3, textContent: t, childNodes: [] });
const el = (tagName: string, kids: CaptureNode[] = [], css: Record<string, string> = {}): CaptureNode & { css: Record<string, string> } =>
  ({ nodeType: 1, tagName: tagName.toUpperCase(), textContent: null, childNodes: kids, css });
const read = (n: CaptureNode) => {
  const css = (n as unknown as { css: Record<string, string> }).css ?? {};
  const keys = Object.keys(css);
  return { length: keys.length, item: (i: number) => keys[i]!, getPropertyValue: (k: string) => css[k] ?? '' };
};

describe('uiSvg', () => {
  it('writes computed styles and text into a foreignObject, escaped, sized to the view', () => {
    const hud = el('div', [el('p', [text('Score <5> & "x"')], { color: 'rgb(1, 2, 3)', 'font-size': '20px' })], { display: 'block' });
    const svg = uiSvg(hud, read, 640, 360);
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"');
    expect(svg).toContain('<foreignObject');
    expect(svg).toContain('color:rgb(1, 2, 3);font-size:20px;');
    expect(svg).toContain('Score &lt;5&gt; &amp; "x"');
    expect(svg).toContain('position:absolute;left:0;top:0;margin:0;width:640px;height:360px');
  });
  it('leaves out hidden elements and self-closes void ones, so the document stays valid XML', () => {
    const svg = uiSvg(el('div', [el('div', [text('gone')], { display: 'none' }), el('img'), el('i', [], { display: 'block' })]), read, 10, 10);
    expect(svg).not.toContain('gone');
    expect(svg).toMatch(/<img style=""\/>/);
    expect(svg).toContain('</i>');
  });
});
