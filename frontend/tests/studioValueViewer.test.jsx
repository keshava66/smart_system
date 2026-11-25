// @vitest-environment jsdom
// Data Studio cell viewer: JSON opens as a readable preview (images drawn),
// a tree you can fold and search, or the raw text; a cut-off cell loads in
// full on its own.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
const { ValueViewer } = await import('../src/pages/dataStudio/sf_pg/valueViewer');

let host;
let root;
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));
const show = (cell) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<ValueViewer cell={cell} onClose={() => {}} />));
};
const items = () => [...document.querySelectorAll('[role="treeitem"]')].map((el) => el.textContent);
const type = (el, value) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const button = (label) => [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent === label);

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

const doc = { meta: { max_image_bytes: 4194304 }, pages: [{ text: 'first page', page_number: 1 }, { text: 'second page', page_number: 2 }] };

it('shows JSON as a tree, two levels open, with search that opens the way to a match', () => {
  show({ title: 'content_json', type: 'jsonb', value: JSON.stringify(doc) });
  expect(document.body.textContent).toContain('jsonb');
  act(() => button('Tree').click());
  expect(items().some((t) => t.startsWith('max_image_bytes:'))).toBe(true);
  expect(items().some((t) => t.startsWith('text:'))).toBe(false);          // pages[0] is folded

  type(document.querySelector('[aria-label="Search in this value"]'), 'second');
  expect(document.body.textContent).toContain('1 of 1');
  expect(items().some((t) => t.includes('second page'))).toBe(true);       // opened to show it
  expect(document.querySelector('mark').textContent).toBe('second');

  act(() => button('Collapse all').click());
  act(() => button('Expand all').click());
  expect(items().some((t) => t.includes('first page'))).toBe(true);
});

it('Text view numbers the formatted lines; plain values and NULL read as they are', () => {
  show({ title: 'content_json', type: 'jsonb', value: JSON.stringify(doc) });
  act(() => button('Raw').click());
  expect(document.querySelector('[data-line="0"]').textContent).toBe('1{');
  act(() => root.unmount());
  host.remove();

  show({ title: 'note', type: 'text', value: 'line one\nline two' });
  expect(button('Tree')).toBeUndefined();
  act(() => button('Raw').click());
  expect(document.querySelector('[data-line="1"]').textContent).toBe('2line two');
  act(() => root.unmount());
  host.remove();

  show({ title: 'note', type: 'text', value: null });
  expect(document.body.textContent).toContain('NULL');
});

it('loads a cut-off cell in full on open, then shows it as JSON', async () => {
  const loadFull = vi.fn(() => Promise.resolve({ value: JSON.stringify(doc), truncated: false, size: 300 }));
  show({ title: 'content_json', type: 'jsonb', value: { $truncated: true, preview: '{"meta": {"max_', size: 300 }, loadFull });
  await flush();
  expect(loadFull).toHaveBeenCalledTimes(1);
  act(() => button('Tree').click());
  expect(items().some((t) => t.startsWith('pages:'))).toBe(true);
});

// 1x1 transparent PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

it('Preview draws base64 images, reads fields as labels and opens a lightbox that Esc closes first', () => {
  const onClose = vi.fn();
  const value = { meta: { max_image_bytes: 4194304, source_url: 'https://example.com/a.pdf' },
    pages: [{ text: 'line one\nline two', page_number: 1, images: [{ ext: 'png', width: 1, height: 1, base64: PNG }] }] };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<ValueViewer cell={{ title: 'content_json', type: 'jsonb', value: JSON.stringify(value) }} onClose={onClose} />));

  expect(document.body.textContent).toContain('Max image bytes');
  expect(document.body.textContent).toContain('4.0 MB');
  expect(document.querySelector('a[href="https://example.com/a.pdf"]')).not.toBeNull();
  const img = document.querySelector('img[alt="image.png"]');
  expect(img.getAttribute('src')).toBe(`data:image/png;base64,${PNG}`);

  act(() => document.querySelector('[aria-label="Open image.png full size"]').click());
  expect(document.querySelector('[aria-label="Image"]')).not.toBeNull();
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(document.querySelector('[aria-label="Image"]')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});
