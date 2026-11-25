// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  htmlToMarkup, markupToHtml, pageScrollbarCss, pastedHtmlToMarkup, scrollbarCss, withPreviewScrollbars,
} from '../src/pages/components/communicationLib';

const toMarkup = (html) => {
  const root = document.createElement('div');
  root.innerHTML = html;
  return htmlToMarkup(root);
};
const roundTrip = (markup) => toMarkup(markupToHtml(markup));

describe('markupToHtml', () => {
  it('renders the blocks the backend renders', () => {
    expect(markupToHtml('## Title\n\nHi **team**,\nline two\n\n- a\n- b\n1. c'))
      .toBe('<h2>Title</h2><p>Hi <strong>team</strong>,<br>line two</p><ul><li>a</li><li>b</li></ul><ol><li>c</li></ol>');
  });

  it('escapes text and only links safe addresses', () => {
    expect(markupToHtml('<img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://a.b/c)'))
      .toBe('<p>&lt;img src=x onerror=alert(1)&gt; [x](javascript:alert(1)) <a href="https://a.b/c">ok</a></p>');
  });

  it('keeps bold inside link text out of the link', () => {
    expect(markupToHtml('[**x**](https://a.b)')).toBe('<p><a href="https://a.b">**x**</a></p>');
  });

  it('nests sub-lists inside their item like the backend', () => {
    expect(markupToHtml('- a\n    - b\n\t\t- c\n- d\n1. e'))
      .toBe('<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul><ol><li>e</li></ol>');
  });

  it('renders bold italic', () => {
    expect(markupToHtml('***both***')).toBe('<p><strong><em>both</em></strong></p>');
  });
});

describe('round trip', () => {
  it.each([
    'Hi Team,\n\nYou now have access to the **CYON_TEST API**, including search.\n\n### Your API key\n\nsmarthub_abc',
    '- one\n- **two**\n- [three](https://x.y)',
    '1. a\n2. b\n\n- c',
    'Line *one*\nline ***two***',
    '# Big\n\n## Mid\n\n### Small',
    '- a\n  - b\n    1. c\n    2. d\n  - e\n- f',
  ])('keeps %j', (markup) => {
    expect(roundTrip(markup)).toBe(markup);
  });
});

describe('htmlToMarkup', () => {
  it('stops typed list and heading marks becoming blocks', () => {
    expect(toMarkup('<p>- not a list</p><p>## not a heading</p><p>2. not numbered</p>'))
      .toBe('​- not a list\n\n​## not a heading\n\n​2. not numbered');
  });

  it('sends a typed asterisk as one that cannot pair up', () => {
    expect(toMarkup('<p>2 * 3 * 4</p>')).toBe('2 ∗ 3 ∗ 4');
  });

  it('keeps touching marks apart', () => {
    expect(toMarkup('<p><i>a</i><b>b</b></p>')).toBe('*a*​**b**');
    expect(markupToHtml(toMarkup('<p><i>a</i><b>b</b></p>'))).toBe('<p><em>a</em>​<strong>b</strong></p>');
  });

  it('moves edge spaces outside the marks and merges split runs', () => {
    expect(toMarkup('<p>x<b> bo</b><b>ld </b>y</p>')).toBe('x **bold** y');
  });

  it('handles loose text, divs and line breaks the browser leaves behind', () => {
    expect(toMarkup('first<div>second</div><div><br></div><div>third<br>fourth</div>'))
      .toBe('first\n\nsecond\n\nthird\nfourth');
  });

  it('writes sub-lists two spaces deeper and drops unsafe links', () => {
    expect(toMarkup('<ul><li>a<ol><li>b</li></ol></li></ul><p><a href="javascript:x()">bad</a></p>'))
      .toBe('- a\n  1. b\n\nbad');
  });

  it('never writes a level the email cannot open', () => {
    // A sub-list with no item above it (Chrome indenting a first item) sits at
    // the top level, and a jump of two levels comes out as one.
    expect(toMarkup('<ul><ul><li>a</li><ol><li>b</li></ol></ul><li>c</li></ul>'))
      .toBe('- a\n  1. b\n- c');
    expect(toMarkup('<ul><li>a<ul><ul><li>b</li></ul></ul></li></ul>')).toBe('- a\n  - b');
    expect(markupToHtml(toMarkup('<ul><ul><li>a</li></ul><li>c</li></ul>'))).toBe('<ul><li>a</li><li>c</li></ul>');
  });

  it('reads the list Chrome indent drops straight inside another list', () => {
    expect(toMarkup('<ul><li>a</li><ul><li>b</li><ul><li>c</li><ul><li>d</li></ul></ul></ul><li>e</li></ul>'))
      .toBe('- a\n  - b\n    - c\n    - d\n- e');
  });
});

describe('pastedHtmlToMarkup', () => {
  it('reads Google Docs and Word styling and ignores the rest', () => {
    const html = '<meta charset="utf-8"><b style="font-weight:normal" id="docs"><p><span style="font-weight:700">Bold</span> '
      + '<span style="font-style:italic">it</span></p><script>alert(1)</script><h1>Head</h1><table><tr><td>cell</td></tr></table></b>';
    expect(pastedHtmlToMarkup(html)).toBe('**Bold** *it*\n\n# Head\n\ncell');
  });
});

describe('inline wrappers round blocks', () => {
  it('carries the wrapper marks into the blocks', () => {
    expect(pastedHtmlToMarkup('<b><p>one</p><ul><li>two</li></ul></b>')).toBe('**one**\n\n- **two**');
  });
});

describe('bare addresses', () => {
  it('shows them styled, as the email links them, and keeps the markup plain', () => {
    const html = markupToHtml('See https://x.y/a?b=1&c=2 now');
    expect(html).toBe('<p>See <span class="cc-rte-url">https://x.y/a?b=1&amp;c=2</span> now</p>');
    expect(toMarkup(html)).toBe('See https://x.y/a?b=1&c=2 now');
  });

  it('keeps the styling true while typing', async () => {
    const { tidyAddresses } = await import('../src/pages/components/communicationLib');
    const root = document.createElement('div');
    root.innerHTML = '<p><span class="cc-rte-url">https://x.y</span> and https://new.z here</p>';
    root.querySelector('span').firstChild.appendData(' tail');
    tidyAddresses(root);
    expect(root.innerHTML).toBe('<p><span class="cc-rte-url">https://x.y</span> tail and <span class="cc-rte-url">https://new.z</span> here</p>');
    root.querySelector('span').firstChild.data = 'not a link';
    tidyAddresses(root);
    expect(root.querySelectorAll('.cc-rte-url').length).toBe(1);
  });
});

describe('Communication Center scrollbars', () => {
  it('scopes the page rules to the Communication Center', () => {
    expect(pageScrollbarCss()).toContain(':is(#main-content:has(.cc-root, .cw), .cc-root, .cc-root *, .cw, .cw *)::-webkit-scrollbar{');
  });

  it('gives every scroller the same rules in the preview, with a chevron per direction', () => {
    const css = scrollbarCss();
    expect(css.startsWith('::-webkit-scrollbar{')).toBe(true);
    for (const where of ['vertical:decrement', 'vertical:increment', 'horizontal:decrement', 'horizontal:increment']) {
      expect(css).toContain(`::-webkit-scrollbar-button:single-button:${where}{background-image:url(`);
    }
    expect(css).toContain('@supports not selector(::-webkit-scrollbar){html{');
  });

  it('puts the preview style after the doctype or in the head, never before the doctype', () => {
    expect(withPreviewScrollbars('<!DOCTYPE html><html><body>x</body></html>'))
      .toMatch(/^<!DOCTYPE html><style data-cc-preview>/);
    expect(withPreviewScrollbars('<html><head><title>t</title></head><body></body></html>'))
      .toMatch(/<title>t<\/title><style data-cc-preview>[\s\S]*<\/style><\/head>/);
  });
});
