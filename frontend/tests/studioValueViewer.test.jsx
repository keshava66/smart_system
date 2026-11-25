// @vitest-environment jsdom
// Data Studio cell viewer: JSON opens as a tree you can fold and search,
// other values as text, and a cut-off cell loads in full on its own.
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
});

const doc = { meta: { max_image_bytes: 4194304 }, pages: [{ text: 'first page', page_number: 1 }, { text: 'second page', page_number: 2 }] };

it('shows JSON as a tree, two levels open, with search that opens the way to a match', () => {
  show({ title: 'content_json', type: 'jsonb', value: JSON.stringify(doc) });
  expect(document.body.textContent).toContain('jsonb');
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
  act(() => button('Text').click());
  expect(document.querySelector('[data-line="0"]').textContent).toBe('1{');
  act(() => root.unmount());
  host.remove();

  show({ title: 'note', type: 'text', value: 'line one\nline two' });
  expect(button('Tree')).toBeUndefined();
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
  expect(items().some((t) => t.startsWith('pages:'))).toBe(true);
});
