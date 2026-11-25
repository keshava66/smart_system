// @vitest-environment jsdom
// Business Defined Checks: history behaviour. Drawers and dialogs are history
// entries, so Back closes them; closing one ourselves goes back exactly once.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
globalThis.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} };
HTMLCanvasElement.prototype.getContext = () => null; // jsdom has no canvas; the page must cope

const SUMMARY = {
  rules: [{ rule_id: 'R1', rule_title: 'Rule one', pass_percentage: 90, severity: 'HIGH', dataset_title: 'DS', target_table: 'T', trend: [], failed_rows: 3 }],
  kpi: { avg_pass: 90, prev_avg_pass: 90.004, rules: 1, failing_rows_known: 1, tables: 1, datasets: 1, at_100: 0, failing_rows: 3, critical: 0 },
  series: [], range: { from_date: '2026-04-01', to_date: '2026-06-30' }, next_run: { at: '2026-07-01' }, domains: null, delta_mode: false, failed_by_rule: { R1: 3 },
  generated_at: '2026-11-24T10:00:00Z', scope: { all: true },
};
let summaryFails = false;
const reply = (status, body) => Promise.resolve({ ok: status < 400, status, statusText: '', json: () => Promise.resolve(body) });
vi.mock('../src/utils/apiClient', () => ({
  apiFetch: (path) => {
    if (path.startsWith('/api/bdc/summary')) return summaryFails ? reply(500, { detail: 'Could not load the summary' }) : reply(200, SUMMARY);
    if (path.startsWith('/api/review/badge')) return reply(200, { pending: 0 });
    if (path.startsWith('/api/trends/')) return reply(200, []);
    return reply(200, {});
  },
  apiEventSource: () => ({ close() {} }),
}));
const perms = new Set(['viewBusinessChecks', 'viewBDCStandard', 'downloadBDCData']);
vi.mock('../src/context/RBACContext', () => ({ useRBAC: () => ({ hasPermission: (p) => perms.has(p), loading: false }) }));
vi.mock('../src/utils/perfTier', () => ({ usePerfTier: () => 'min', measureTier: () => {} }));

const { default: BusinessDefinedChecks } = await import('../src/pages/BusinessDefinedChecks');

let loc = null;
const Probe = () => { loc = useLocation(); return null; };
let host;
let root;
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(() => new Promise((r) => setTimeout(r, 0))); };
const routes = (
  <Routes>
    <Route path="/dqe" element={<><BusinessDefinedChecks onBack={() => {}} /><Probe /></>} />
    <Route path="/elsewhere" element={<Probe />} />
  </Routes>
);
async function mount(router) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(router));
  await flush();
}
const open = (entries) => mount(<MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>{routes}</MemoryRouter>);
const esc = () => act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

beforeEach(() => {
  summaryFails = false;
  window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

const BASE = '?check=Business_defined_checks';

describe('BDC history', () => {
  it('closes a drawer with one step back to where it was opened', async () => {
    await open(['/elsewhere', `/dqe${BASE}`, { pathname: '/dqe', search: `${BASE}&drawer=rule%3AR1`, state: { bdxLayer: 1 } }]);
    expect(document.body.querySelector('.bdx-layer')).not.toBeNull();
    esc();
    await flush();
    expect(loc.pathname).toBe('/dqe');
    expect(loc.search).toBe(BASE);
  });

  it('drops a tab this role cannot open from the URL', async () => {
    await open([`/dqe${BASE}&tab=admin`]);
    expect(loc.search).toBe(BASE);
  });

  it('shows an error with a retry when the summary fails', async () => {
    summaryFails = true;
    // Semi-Monthly: a cadence the earlier tests have not cached
    await open([`/dqe${BASE}&mode=delta&tab=dataset-health`]);
    expect(host.textContent).toContain('Could not load datasets');
    expect(host.textContent).toContain('Could not load the summary');
    expect(host.querySelector('[role="alert"] button')).not.toBeNull();
  });

  it('reads a drift that rounds to 0.0 as no change, and flags a past run date', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-24T12:00:00') });
    try {
      await open([`/dqe${BASE}`]);
      expect(host.textContent).toContain('No change');
      expect(host.textContent).not.toContain('0.0 pts');
      expect(host.textContent).toContain('Next scheduled run · overdue');
    } finally {
      vi.useRealTimers();
    }
  });

    it('titles the browser tab after the open tab', async () => {
    await open([`/dqe${BASE}&tab=trends`]);
    expect(document.title).toBe('Trends · Business Defined Checks · SmartHub');
  });
});
