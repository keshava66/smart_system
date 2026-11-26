// @vitest-environment jsdom
// Data Studio Profile: the page in the browser by default, and on request the
// whole result or whole table, profiled by the server and kept per scope.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { ProfileView } = await import('../src/pages/dataStudio/sf_pg/resultViews');

let host;
let root;
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));
const radio = (text) => [...document.querySelectorAll('[role="radio"]')].find((b) => b.textContent.startsWith(text));

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const columns = [{ name: 'page_count', type: 'integer' }, { name: 's3_key', type: 'text' }];
const families = ['num', 'text'];
const rows = [[1, 'a'], [2, 'b']];

it('profiles the page, then the whole table on request, once per scope', async () => {
  const load = vi.fn(() => Promise.resolve({
    rows: 1204, elapsed_ms: 840, columns_skipped: 0, source: 'table',
    columns: [
      { name: 'page_count', type: 'integer', family: 'num', filled: 1200, distinct: 19, min: 1, max: 59, avg: 4, bins: Array(18).fill(0).map((_, i) => (i === 0 ? 900 : 10)) },
      { name: 's3_key', type: 'text', family: 'text', filled: 1204, distinct: 1204, top: [['landing/x', 1]] },
      { name: 'only_in_table', type: 'text', family: 'text', filled: 0, distinct: 0, top: [] },
    ],
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const scopes = [{ id: 'table', label: 'Whole table · blobs', name: 'blobs', key: 't|blobs', load }];
  act(() => root.render(<ProfileView columns={columns} families={families} rows={rows} total={1204} accent="#336791" onChart={() => {}} scopes={scopes} />));
  expect(document.body.textContent).toContain('The 2 rows on this page of 1,204');
  expect(document.body.textContent).toContain('1 to 2');
  expect(load).not.toHaveBeenCalled();

  act(() => radio('Whole table').click());
  expect(radio('Whole table').getAttribute('aria-checked')).toBe('true');
  expect(radio('This page').getAttribute('aria-checked')).toBe('false');
  expect(document.body.textContent).toContain('Profiling every row of blobs');
  await flush();
  expect(load).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain('Every row of blobs: 1,204 rows');
  expect(document.body.textContent).toContain('1 to 59');
  expect(document.body.textContent).toContain('19 distinct');
  expect(document.body.textContent).toContain('Every value is different');
  expect(document.body.textContent).toContain('only_in_table');

  act(() => radio('This page').click());
  act(() => radio('Whole table').click());
  await flush();
  expect(load).toHaveBeenCalledTimes(1);             // kept, not asked again

  act(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Refresh').click());
  await flush();
  expect(load).toHaveBeenCalledTimes(2);
});

it('says what went wrong and offers a retry', async () => {
  const load = vi.fn(() => Promise.reject(new Error('Could not profile this table: permission denied')));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<ProfileView columns={columns} families={families} rows={rows} total={2} accent="#336791" onChart={() => {}}
    scopes={[{ id: 'result', label: 'All 5,000 rows', key: 'r|1', load }]} />));
  act(() => radio('All 5,000 rows').click());
  await flush();
  expect(document.body.textContent).toContain('permission denied');
  expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Try again')).toBe(true);
});
