// @vitest-environment jsdom
// Data Studio explorer: objects created, dropped or renamed show up without
// waiting for the server's metadata cache, and expanded nodes stay expanded.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let schemas = ['PUBLIC'];
const calls = [];
vi.mock('../src/pages/dataStudio/shared/studioHelpers', async (orig) => ({
  ...(await orig()),
  fetchJson: (url, opts) => {
    calls.push(`${opts?.method || 'GET'} ${url}`);
    if (url.includes('/databases')) return Promise.resolve({ databases: ['DB1'] });
    if (url.includes('/schemas')) return Promise.resolve({ schemas: [...schemas] });
    return Promise.resolve({ ok: true });
  },
}));

const { SfExplorer } = await import('../src/pages/dataStudio/sf_pg/explorer');

let host;
let root;
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));
const render = (props) => act(() => root.render(<SfExplorer {...props} />));
const text = () => host.textContent;

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  calls.length = 0;
  schemas = ['PUBLIC'];
  localStorage.clear();
});

const mount = (props) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  render(props);
};

it('reads live lists and re-reads what is expanded when objects change', async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  render({ catalogVersion: 0 });
  await flush();
  expect(calls).toContain('GET /api/snowflake/databases?bypass_cache=true');

  const db = [...host.querySelectorAll('[role="treeitem"]')].find(el => el.textContent.includes('DB1'));
  await act(async () => db.click());
  await flush();
  expect(calls).toContain('GET /api/snowflake/schemas?database=DB1&bypass_cache=true');
  expect(text()).toContain('PUBLIC');
  expect(text()).not.toContain('STAGING');

  schemas = ['PUBLIC', 'STAGING'];          // created by a run in a worksheet
  calls.length = 0;
  render({ catalogVersion: 1 });
  await flush();
  expect(calls).toContain('GET /api/snowflake/schemas?database=DB1&bypass_cache=true');
  expect(text()).toContain('STAGING');      // still expanded, now with the new schema
});

it('Refresh clears the server cache, then tells the pane', async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const onRefresh = vi.fn();
  render({ catalogVersion: 0, onRefresh });
  await flush();
  await act(async () => host.querySelector('[aria-label="Refresh objects"]').click());
  await flush();
  expect(calls).toContain('POST /api/snowflake/catalog/refresh');
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

it('comes back expanded, scrolled and selected after a browser reload', async () => {
  const onSelect = vi.fn();
  mount({ catalogVersion: 0, onSelect });
  await flush();
  const db = [...host.querySelectorAll('[role="treeitem"]')].find(el => el.textContent.includes('DB1'));
  await act(async () => db.click());
  await flush();
  const sel = onSelect.mock.calls.at(-1)[0];
  render({ catalogVersion: 0, onSelect, selected: sel });
  const tree = host.querySelector('[role="tree"]');
  tree.scrollTop = 120;
  await act(async () => { tree.dispatchEvent(new Event('scroll')); await new Promise(r => setTimeout(r, 250)); });

  act(() => root.unmount());              // the reload
  host.remove();
  calls.length = 0;
  schemas = ['PUBLIC', 'STAGING'];
  const onSelect2 = vi.fn();
  mount({ catalogVersion: 0, onSelect: onSelect2 });
  await flush();
  await flush();
  expect(calls).toContain('GET /api/snowflake/schemas?database=DB1&bypass_cache=true');   // read fresh, no click
  expect(text()).toContain('STAGING');
  expect(onSelect2).toHaveBeenCalledWith(sel);
  expect(host.querySelector('[role="tree"]').scrollTop).toBe(120);
});
