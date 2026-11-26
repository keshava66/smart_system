// @vitest-environment jsdom
// Data Studio Profile: each card shows the page in the browser, and its
// "Whole table" button shows that column over every row, from the server.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { ProfileView } = await import('../src/pages/dataStudio/sf_pg/resultViews');

let host;
let root;
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));
const cards = () => [...host.querySelectorAll('.grid > div')];
const card = (name) => cards().find((c) => c.querySelector('.font-bold').textContent === name);
const btn = (el, text) => [...el.querySelectorAll('button')].find((b) => b.textContent.startsWith(text));

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const columns = [{ name: 'page_count', type: 'integer' }, { name: 's3_key', type: 'text' }];
const families = ['num', 'text'];
const rows = [[1, 'a'], [2, 'b']];
const mount = (wide, onChart = () => {}) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<ProfileView columns={columns} families={families} rows={rows} total={1204} accent="#336791" onChart={onChart} wide={wide} />));
};

it('a card swaps to its column over the whole table and back, asking once', async () => {
  const load = vi.fn(() => Promise.resolve({
    rows: 1204, elapsed_ms: 840, columns_skipped: 0,
    columns: [{ name: 'page_count', type: 'integer', family: 'num', filled: 1200, distinct: 19, min: 1, max: 59, avg: 4, bins: Array(18).fill(3) }],
  }));
  mount({ label: 'Whole table', title: 'This column over every row of blobs', key: 't|blobs', load });
  expect(card('page_count').textContent).toContain('1 to 2');

  act(() => btn(card('page_count'), 'Whole table').click());
  expect(card('page_count').textContent).toContain('Working');
  await flush();
  expect(load).toHaveBeenCalledWith(['page_count']);
  expect(card('page_count').textContent).toContain('1 to 59');
  expect(card('page_count').textContent).toContain('19 distinct');
  expect(card('page_count').textContent).toContain('Whole table · 1,204');
  expect(card('s3_key').textContent).not.toContain('1,204');      // the other cards stay on the page

  act(() => btn(card('page_count'), 'Whole table ·').click());    // back to the page
  expect(card('page_count').textContent).toContain('1 to 2');
  act(() => btn(card('page_count'), 'Whole table').click());
  expect(card('page_count').textContent).toContain('1 to 59');
  expect(load).toHaveBeenCalledTimes(1);
});

it('no button without a table or bigger result; errors stay on their card', async () => {
  mount(null);
  expect(btn(card('page_count'), 'Whole table')).toBeUndefined();
  act(() => root.unmount());
  host.remove();

  mount({ label: 'All rows', title: '', key: 'r|1', load: () => Promise.reject(new Error('s3_key is not a column of blobs')) });
  act(() => btn(card('s3_key'), 'All rows').click());
  await flush();
  expect(card('s3_key').textContent).toContain('s3_key is not a column of blobs');
  expect(card('page_count').textContent).not.toContain('not a column');
});

it('the button does not also open the chart', () => {
  const onChart = vi.fn();
  mount({ label: 'Whole table', title: '', key: 'k', load: () => new Promise(() => {}) }, onChart);
  act(() => btn(card('s3_key'), 'Whole table').click());
  expect(onChart).not.toHaveBeenCalled();
});
