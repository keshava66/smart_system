// @vitest-environment jsdom
// Data Quality Engine: the URL decides which suite is open, and a URL that
// doesn't match what this person can open is corrected, never left dangling.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

let perms = new Set();
vi.mock('../src/context/RBACContext', () => ({
  useRBAC: () => ({ hasPermission: (p) => perms.has(p), loading: false }),
}));
vi.mock('../src/utils/apiClient', () => ({
  apiFetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
}));
// The suites themselves are tested elsewhere; here only what the engine hands them matters.
const stub = (name) => ({ default: ({ onBack }) => <div data-suite={name} data-back={onBack ? 'yes' : 'no'} onClick={onBack} /> });
vi.mock('../src/pages/BusinessDefinedChecks', () => stub('bdc'));
vi.mock('../src/pages/SafetyDQ', () => stub('safety'));
vi.mock('../src/pages/DataValidation', () => stub('dv'));
vi.mock('../src/pages/IndCtaDataQuality', () => stub('ind'));
vi.mock('../src/pages/ITChecksView', () => ({ default: ({ canSwitch }) => <div data-suite="it" data-back={canSwitch ? 'yes' : 'no'} /> }));

const { default: DQEngine } = await import('../src/pages/DQEngine');

let search = '';
const Probe = () => { search = useLocation().search; return null; };

let host;
let root;
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));
async function open(url) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(
    <MemoryRouter initialEntries={[url]}>
      <Routes><Route path="/dqe" element={<><DQEngine /><Probe /></>} /></Routes>
    </MemoryRouter>,
  ));
  // lazy suite files resolve on a later tick
  await flush();
  await flush();
}
const suite = () => host.querySelector('[data-suite]');

beforeEach(() => {
  window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  perms = new Set(['viewBusinessChecks', 'viewSafetyDQ', 'viewDataValidation']);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

describe('DQ Engine routing', () => {
  it('opens the suite named in the URL, with a way back to the picker', async () => {
    await open('/dqe?check=Business_defined_checks&tab=trends');
    expect(suite()?.dataset.suite).toBe('bdc');
    expect(suite().dataset.back).toBe('yes');
    expect(search).toBe('?check=Business_defined_checks&tab=trends');
    act(() => suite().click());
    expect(search).toBe('');
    expect(host.textContent).toContain('Choose your check type');
  });

  it('drops an unknown suite from the URL and shows the picker', async () => {
    await open('/dqe?check=Nope');
    expect(search).toBe('');
    expect(suite()).toBeNull();
    expect(host.textContent).toContain('Choose your check type');
  });

  it('sends a suite this role cannot open back to the picker', async () => {
    await open('/dqe?check=IT_Checks');
    expect(search).toBe('');
    expect(host.textContent).toContain('Choose your check type');
  });

  it('drops IT Checks run selections outside IT Checks', async () => {
    await open('/dqe?check=Safety_DQ&run=2026-01-01');
    expect(search).toBe('?check=Safety_DQ');
    expect(suite()?.dataset.suite).toBe('safety');
  });

  it('gives Safety no way back to the picker', async () => {
    await open('/dqe?check=Safety_DQ');
    expect(suite()?.dataset.suite).toBe('safety');
    expect(suite().dataset.back).toBe('no');
  });

  it('skips the picker with one suite and offers no back button', async () => {
    perms = new Set(['viewBusinessChecks']);
    await open('/dqe');
    expect(search).toBe('?check=Business_defined_checks');
    expect(suite()?.dataset.suite).toBe('bdc');
    expect(suite().dataset.back).toBe('no');
  });

  it('explains an engine with no suites instead of an empty picker', async () => {
    perms = new Set();
    await open('/dqe');
    expect(host.textContent).toContain('No check suites available');
  });

  it('titles the browser tab after the open suite', async () => {
    await open('/dqe?check=Safety_DQ');
    expect(document.title).toBe('Safety · Data Quality Engine · SmartHub');
  });
});
