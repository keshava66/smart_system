// @vitest-environment jsdom
// Checks for the production-hardening release, one block per frontend change.
// Run: npm test   (the live, in-browser side is in scripts/release_check.py)
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const repo = resolve(process.cwd(), '..'); // vitest runs from frontend/

// ----------------------------------------------------------------- test plumbing

let widthPx = 1440;
function setWidth(px) {
  widthPx = px;
  window.__mqListeners?.forEach((fn) => fn());
}
// jsdom has no layout engine; the sidebar only uses this to shade its scroll edges.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

beforeEach(() => {
  window.__mqListeners = new Set();
  window.matchMedia = (query) => {
    const max = /max-width:\s*([\d.]+)px/.exec(query);
    const min = /min-width:\s*([\d.]+)px/.exec(query);
    const matches = () => (max ? widthPx <= Number(max[1]) : true) && (min ? widthPx >= Number(min[1]) : true);
    return {
      get matches() { return matches(); },
      media: query,
      addEventListener: (_t, fn) => window.__mqListeners.add(fn),
      removeEventListener: (_t, fn) => window.__mqListeners.delete(fn),
    };
  };
});

let host;
let root;
function mount(ui) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(ui));
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  setWidth(1440);
});

vi.mock('../src/context/RBACContext', () => ({
  useRBAC: () => ({ hasPermission: () => true, loading: false, roleDefinition: { name: 'Admin' } }),
}));
const logout = vi.fn();
vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ user: { name: 'Rivera, Ana', email: 'ana.rivera@its.jnj.com' }, logout }),
}));
vi.mock('../src/context/AssistantSettingsContext', () => ({
  useAssistantSettings: () => ({ enabled: false, setEnabled: vi.fn() }),
}));
const apiFetch = vi.fn(async () => ({ ok: true, json: async () => ({ preferences: { reduce_motion: true } }) }));
vi.mock('../src/utils/apiClient', () => ({ apiFetch: (...a) => apiFetch(...a) }));
vi.mock('../src/hooks/useProfilePhoto', () => ({
  useProfilePhoto: () => ({ profilePhoto: null, photoLoading: false }),
}));

// ------------------------------------------------------------ media query hook

describe('useMediaQuery', async () => {
  const { useMediaQuery, NARROW, WIDE } = await import('../src/hooks/useMediaQuery');

  it('uses the Tailwind lg and xl breakpoints', () => {
    expect(NARROW).toBe('(max-width: 1023.98px)');
    expect(WIDE).toBe('(min-width: 1280px)');
  });

  it('follows the viewport as it changes', () => {
    const Probe = () => <span>{useMediaQuery(NARROW) ? 'narrow' : 'wide'}</span>;
    setWidth(375);
    const el = mount(<Probe />);
    expect(el.textContent).toBe('narrow');
    act(() => setWidth(1024));
    expect(el.textContent).toBe('wide');
    act(() => setWidth(1023));
    expect(el.textContent).toBe('narrow');
  });
});

// ------------------------------------------------------------------ MenuButton

describe('MenuButton', async () => {
  const { default: MenuButton } = await import('../src/components/MenuButton');

  it('names its state and the drawer it controls', () => {
    const onClick = vi.fn();
    const el = mount(<MenuButton open={false} onClick={onClick} />);
    const btn = el.querySelector('button');
    expect(btn.getAttribute('aria-label')).toBe('Open menu');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-controls')).toBe('main-navigation');
    act(() => btn.click());
    expect(onClick).toHaveBeenCalledOnce();
    act(() => root.render(<MenuButton open onClick={onClick} />));
    expect(btn.getAttribute('aria-label')).toBe('Close menu');
  });
});

// --------------------------------------------------------------- Sidebar drawer

describe('Sidebar on phones and tablets', async () => {
  const { default: Sidebar } = await import('../src/components/Sidebar');

  function Shell({ startOpen = true }) {
    const [open, setOpen] = useState(startOpen);
    const loc = useLocation();
    return (
      <>
        <span data-testid="path">{loc.pathname}</span>
        <span data-testid="open">{String(open)}</span>
        <Sidebar drawerOpen={open} onDrawerClose={() => setOpen(false)} />
      </>
    );
  }
  const render = (startOpen) => mount(
    <MemoryRouter initialEntries={['/about']}>
      <Routes><Route path="*" element={<Shell startOpen={startOpen} />} /></Routes>
    </MemoryRouter>,
  );
  const aside = () => host.querySelector('aside#main-navigation');
  const isOpen = () => host.querySelector('[data-testid=open]').textContent === 'true';

  it('is a full-label drawer with a close button and a scrim', () => {
    setWidth(375);
    render(true);
    expect(aside().className).toMatch(/\bmobile\b/);
    expect(aside().className).toMatch(/\bdrawer\b/);
    expect(aside().className).toMatch(/\bopen\b/);
    expect(host.querySelector('.sb-scrim.on')).toBeTruthy();
    expect(host.querySelector('button[aria-label="Close menu"]')).toBeTruthy();
    expect(host.querySelector('.sb-toggle')).toBeNull();
  });

  it('closes on the close button', () => {
    setWidth(375);
    render(true);
    act(() => host.querySelector('button[aria-label="Close menu"]').click());
    expect(isOpen()).toBe(false);
  });

  it('closes on the scrim', () => {
    setWidth(375);
    render(true);
    act(() => host.querySelector('.sb-scrim').click());
    expect(isOpen()).toBe(false);
  });

  it('closes on Escape', () => {
    setWidth(375);
    render(true);
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(isOpen()).toBe(false);
  });

  it('closes when you pick a page, and goes there', () => {
    setWidth(375);
    render(true);
    const dash = [...host.querySelectorAll('aside button, aside a')].find((b) => /Dashboard/.test(b.textContent));
    expect(dash).toBeTruthy();
    act(() => dash.click());
    expect(isOpen()).toBe(false);
    expect(host.querySelector('[data-testid=path]').textContent).toBe('/dashboard');
  });

  it('is hidden from keyboard and screen readers while shut', () => {
    setWidth(375);
    render(false);
    expect(aside().hasAttribute('inert')).toBe(true);
    expect(aside().getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('.sb-scrim.on')).toBeNull();
  });

  it('collapsed: the hover card names the page and says what it does', () => {
    setWidth(1440);
    mount(<MemoryRouter><Sidebar expanded={false} /></MemoryRouter>);
    const link = [...host.querySelectorAll('aside .sb-link')].find((l) => l.getAttribute('href') === '/fuzzy-match');
    act(() => link.focus());
    const card = host.querySelector('.sb-fly-card');
    expect(card.querySelector('.sb-fly-head').textContent).toBe('Fuzzy match');
    expect(host.querySelector('.sb-fly > .sb-fly-hint[role=tooltip]').textContent).toMatch(/Denodo/);
    expect(card.classList.contains('has-subs')).toBe(false);
  });

  it('shows no NEW badges', () => {
    for (const [w, ui] of [[375, <Sidebar drawerOpen onDrawerClose={() => {}} />], [1440, <Sidebar expanded />]]) {
      setWidth(w);
      mount(<MemoryRouter>{ui}</MemoryRouter>);
      expect(aside().textContent).toMatch(/Data quality/);
      expect(aside().querySelector(".sb-new, .sb-fly-new")).toBeNull();
      expect(aside().textContent).not.toContain("NEW");
      act(() => root.unmount()); host.remove(); root = null;
    }
  });

  it('shows no sub-page chevrons or popup roles in the drawer', () => {
    setWidth(375);
    render(true);
    expect(aside().querySelector('.sb-link[aria-haspopup]')).toBeNull();
    expect(aside().querySelectorAll('.sb-link').length).toBeGreaterThan(3);
  });

  it('is a normal sidebar from 1024px up', () => {
    setWidth(1280);
    render(false);
    expect(aside().className).not.toMatch(/\bmobile\b/);
    expect(aside().hasAttribute('inert')).toBe(false);
    expect(host.querySelector('.sb-scrim')).toBeNull();
    expect(host.querySelector('button[aria-label="Close menu"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------- Header

describe('Header', async () => {
  const { default: Header } = await import('../src/components/Header');
  const { PALETTE_EVENT } = await import('../src/utils/events');

  it('shows the hamburger below 1024px and the collapse button above', () => {
    setWidth(375);
    const el = mount(<MemoryRouter><Header navOpen={false} onToggleNav={() => {}} /></MemoryRouter>);
    expect(el.querySelector('button[aria-controls="main-navigation"]')).toBeTruthy();
    act(() => setWidth(1440));
    expect(el.querySelector('button[aria-controls="main-navigation"]')).toBeNull();
  });

  it('search button still opens the command palette', () => {
    const heard = vi.fn();
    window.addEventListener(PALETTE_EVENT, heard);
    const el = mount(<MemoryRouter><Header navOpen onToggleNav={() => {}} /></MemoryRouter>);
    const search = [...el.querySelectorAll('button')].find((b) => /search/i.test(b.getAttribute('aria-label') || b.title || b.textContent));
    expect(search).toBeTruthy();
    act(() => search.click());
    expect(heard).toHaveBeenCalled();
    window.removeEventListener(PALETTE_EVENT, heard);
  });

  it('account menu: first and last name on the button, full details and preferences inside', async () => {
    globalThis.HTMLDialogElement && (HTMLDialogElement.prototype.showModal ??= function () { this.open = true; });
    globalThis.HTMLDialogElement && (HTMLDialogElement.prototype.close ??= function () { this.open = false; });
    setWidth(1440);
    const el = mount(<MemoryRouter><Header navOpen onToggleNav={() => {}} /></MemoryRouter>);
    const chip = el.querySelector('button[aria-haspopup="menu"]');
    expect(chip.textContent).toContain('Ana Rivera');
    expect(chip.textContent).not.toContain(',');
    expect(chip.textContent).toContain('Admin');
    expect(chip.textContent).not.toMatch(/Role:/);
    act(() => chip.click());
    const menu = el.querySelector('[role=menu]');
    expect(menu.textContent).toContain('Rivera, Ana');
    expect(menu.textContent).toContain('ana.rivera@its.jnj.com');
    expect(menu.textContent).toContain('Admin');
    expect(menu.textContent).toContain('Preferences');
    expect(menu.textContent).toContain('Floating helper on every page');
    expect(menu.textContent).toContain('Calmer pages, fewer animations');
    expect(menu.textContent).not.toMatch(/\b(Enabled|Disabled|Off)\b/);
    expect(menu.textContent).toContain("What's new");
    const keys = [...menu.querySelectorAll('[role=menuitem]')].find((b) => b.textContent === 'Keyboard shortcuts');
    act(() => keys.click());
    const dialog = el.querySelector('dialog[aria-labelledby=shortcuts-title]');
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('Collapse or expand the sidebar');
    act(() => chip.click());
    expect(el.querySelector('[role=menu]')).toBeTruthy();
    const out = [...el.querySelectorAll('[role=menuitem]')].find((b) => b.textContent.includes('Sign out'));
    act(() => out.click());
    const ask = el.querySelector('dialog[aria-labelledby=signout-title]');
    expect(ask.open).toBe(true);
    expect(logout).not.toHaveBeenCalled();
    act(() => [...ask.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click());
    expect(logout).not.toHaveBeenCalled();
    expect(el.querySelector('[role=menu]')).toBeTruthy(); // menu still open behind it
    act(() => { ask.showModal(); });
    await act(async () => [...ask.querySelectorAll('button')].find((b) => b.textContent === 'Sign out').click());
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('exposes the user menu state', () => {
    const el = mount(<MemoryRouter><Header navOpen onToggleNav={() => {}} /></MemoryRouter>);
    const chip = el.querySelector('button[aria-haspopup="menu"]');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    act(() => chip.click());
    expect(chip.getAttribute('aria-expanded')).toBe('true');
  });
});

// ------------------------------------------------------------- Reduce motion

describe('Reduce motion setting', () => {
  const read = (p) => readFileSync(resolve(repo, p), 'utf8');
  const fresh = async () => { vi.resetModules(); return import('../src/utils/motion'); };
  const html = () => document.documentElement.classList;

  beforeEach(() => {
    localStorage.clear();
    html().remove('reduce-motion');
    apiFetch.mockClear();
  });

  it('is off by default, even when the OS asks for reduced motion', async () => {
    const real = window.matchMedia;
    window.matchMedia = (q) => ({ ...real(q), matches: /prefers-reduced-motion/.test(q) || real(q).matches });
    const m = await fresh();
    expect(m.reducedMotion()).toBe(false);
    expect(html().contains('reduce-motion')).toBe(false);
  });

  it('puts the class on <html> and keeps the choice', async () => {
    const m = await fresh();
    m.setReducedMotion(true);
    expect(html().contains('reduce-motion')).toBe(true);
    expect(localStorage.getItem('smarthub.reduceMotion')).toBe('true');
    html().remove('reduce-motion');
    const again = await fresh();
    expect(again.reducedMotion()).toBe(true);
    expect(html().contains('reduce-motion')).toBe(true);
    again.setReducedMotion(false);
    expect(html().contains('reduce-motion')).toBe(false);
  });

  it("carries over the assistant panel's old switch", async () => {
    localStorage.setItem('regwiz-reduce-motion', '1');
    const m = await fresh();
    expect(m.reducedMotion()).toBe(true);
    m.setReducedMotion(true);
    m.setReducedMotion(false);
    expect(localStorage.getItem('regwiz-reduce-motion')).toBeNull();
  });

  it('saves to the account and takes the saved value on sign-in', async () => {
    const m = await fresh();
    await m.saveReducedMotion(true);
    expect(apiFetch).toHaveBeenCalledWith('/api/audit/preferences', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ reduce_motion: true }) }));
    m.setReducedMotion(false);
    const Probe = () => { m.useSyncedMotionPreference('ana.rivera@its.jnj.com'); return null; };
    mount(<Probe />);
    await act(async () => {});
    expect(apiFetch).toHaveBeenCalledWith('/api/audit/preferences');
    expect(m.reducedMotion()).toBe(true);
    m.setReducedMotion(false);
  });

  it('caps the performance tier at lite while on, and restores it after', async () => {
    const m = await fresh();
    const perf = await import('../src/utils/perfTier');
    const base = perf.getTier();
    m.setReducedMotion(true);
    expect(perf.getTier()).toBe(base === 'full' ? 'lite' : base);
    m.setReducedMotion(false);
    expect(perf.getTier()).toBe(base);
  });

  it('has a switch in both account menus', async () => {
    vi.resetModules();
    const m = await import('../src/utils/motion');
    const { default: Sidebar } = await import('../src/components/Sidebar');
    const { default: Header } = await import('../src/components/Header');

    setWidth(375);
    mount(<MemoryRouter><Sidebar drawerOpen onDrawerClose={() => {}} /></MemoryRouter>);
    act(() => host.querySelector('.sb-user button').click());
    expect(host.querySelector('.sb-menu-head .sb-menu-name').textContent).toBe('Rivera, Ana');
    expect(host.querySelector('.sb-menu-head .sb-menu-mail').textContent).toBe('ana.rivera@its.jnj.com');
    const sbSwitch = host.querySelector('.sb-menu [role=switch][aria-label="Reduce motion"]');
    expect(sbSwitch.getAttribute('aria-checked')).toBe('false');
    act(() => sbSwitch.click());
    expect(m.reducedMotion()).toBe(true);
    expect(host.querySelector('.sb-menu [aria-label="Reduce motion"]').getAttribute('aria-checked')).toBe('true');
    act(() => root.unmount()); host.remove(); root = null;

    setWidth(1440);
    mount(<MemoryRouter><Header navOpen onToggleNav={() => {}} /></MemoryRouter>);
    act(() => host.querySelector('button[aria-haspopup="menu"]').click());
    const hdSwitch = host.querySelector('[role=switch][aria-label="Reduce motion"]');
    expect(hdSwitch.getAttribute('aria-checked')).toBe('true');
    act(() => hdSwitch.click());
    expect(m.reducedMotion()).toBe(false);
  });

  it('nothing in the portal reads the OS setting or keeps its own switch', () => {
    const src = resolve(repo, 'frontend/src');
    const hits = readdirSync(src, { recursive: true })
      .filter((f) => /\.(jsx?|css)$/.test(f))
      .filter((f) => {
        const text = readFileSync(resolve(src, f), 'utf8');
        return /prefers-reduced-motion|motion-reduce:|motion-safe:/.test(text)
          || (/regwiz-reduce-motion/.test(text) && !f.endsWith('motion.js'));
      });
    expect(hits).toEqual([]);
    expect(read('frontend/src/main.jsx')).toContain("import './utils/motion'");
  });
});

// ------------------------------------------------------------------ SearchSection

describe('SearchSection (shared by the five explorers)', async () => {
  const { default: SearchSection } = await import('../src/components/SearchSection');

  function Form({ initial = '' }) {
    const [a, setA] = useState(initial);
    const [b, setB] = useState('');
    return (
      <SearchSection>
        <input aria-label="a" value={a} onChange={(e) => setA(e.target.value)} />
        <input aria-label="b" value={b} onChange={(e) => setB(e.target.value)} />
        <button type="button" onClick={() => { setA(''); setB(''); }}>clear</button>
      </SearchSection>
    );
  }
  const type = (input, value) => act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const badge = (el) => el.querySelector('button[aria-expanded] span span')?.textContent ?? null;

  it('starts closed with no count', () => {
    const el = mount(<Form />);
    expect(el.querySelector('button[aria-expanded]').getAttribute('aria-expanded')).toBe('false');
    expect(badge(el)).toBeNull();
  });

  it('counts filled boxes as you type, and drops the count when cleared', () => {
    const el = mount(<Form />);
    act(() => el.querySelector('button[aria-expanded]').click());
    type(el.querySelector('[aria-label=a]'), 'aspirin');
    expect(badge(el)).toBe('1');
    type(el.querySelector('[aria-label=b]'), 'x');
    expect(badge(el)).toBe('2');
    type(el.querySelector('[aria-label=b]'), '   ');
    expect(badge(el)).toBe('1');
    act(() => [...el.querySelectorAll('button')].find((b) => b.textContent === 'clear').click());
    expect(badge(el)).toBeNull();
  });

  it('opens by itself when it mounts with a search already filled in', () => {
    const el = mount(<Form initial="kept" />);
    expect(el.querySelector('button[aria-expanded]').getAttribute('aria-expanded')).toBe('true');
    expect(badge(el)).toBe('1');
  });

  it('is the only copy: the five explorers import it instead of defining their own', () => {
    for (const f of ['pages/Unstructured.jsx', 'pages/components/ChunkExplorer.jsx', 'pages/components/EpodExplorer.jsx',
      'pages/components/FDAExplorer.jsx', 'pages/components/NipoExplorer.jsx']) {
      const src = readFileSync(resolve(repo, 'frontend/src', f), 'utf8');
      expect(src, f).toMatch(/import SearchSection from '.*components\/SearchSection'/);
      expect(src, f).not.toMatch(/function SearchSection\(/);
      expect(src, f).toMatch(/<SearchSection>/);
    }
  });
});

// ------------------------------------------------------------- Data Studio panes

describe('Data Studio', async () => {
  const { PANES } = await import('../src/pages/dataStudio/panes');

  it('loads every pane lazily', () => {
    expect(PANES.map((p) => p.id)).toEqual(['snowflake', 'postgres', 'indexer', 's3', 'streamsets', 'shuttle']);
    for (const p of PANES) expect(p.component.$$typeof, p.id).toBe(Symbol.for('react.lazy'));
  });

  it('every lazy pane resolves to a component', async () => {
    for (const p of PANES) {
      const mod = await p.component._payload._result();
      expect(typeof mod.default, p.id).toBe('function');
    }
  }, 60000);

  it('wraps panes in Suspense so a loading pane keeps the tab bar', () => {
    const src = readFileSync(resolve(repo, 'frontend/src/pages/dataStudio/DataStudio.jsx'), 'utf8');
    expect(src.match(/<Suspense fallback=\{<PaneLoading \/>\}>/g)).toHaveLength(2);
  });
});

// ------------------------------------------------------- Key email editor markup

describe('Publish markdown renderer', async () => {
  const { mdToHtml } = await import('../src/pages/dataApi/markdown');

  it('cannot be broken out of with a quote in a link', () => {
    const html = mdToHtml('[x](https://a.example/"onmouseover="alert(1))');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const a = doc.querySelector('a');
    expect(a.getAttributeNames()).toEqual(['href']);
    expect(a.getAttribute('href')).toContain('"onmouseover="');
  });

  it('escapes raw markup', () => {
    expect(mdToHtml('<img src=x onerror=alert(1)>')).not.toMatch(/<img/);
  });

  it('keeps the formatting it had', () => {
    expect(mdToHtml('# Title\n\nHi **you** and *me*\n\n- one\n- two\n\n1. a\n2. b')).toBe(
      '<h3>Title</h3><p>Hi <strong>you</strong> and <em>me</em></p><ul><li>one</li><li>two</li></ul><ol><li>a</li><li>b</li></ol>');
    expect(mdToHtml('Your key: {{key}}')).toContain('data-token="{{key}}">API key</span>');
    expect(mdToHtml('[docs](https://x.example/d)')).toBe('<p><a href="https://x.example/d">docs</a></p>');
  });
});

// --------------------------------------------------------- moved helper modules

describe('communicationLib', async () => {
  const lib = await import('../src/pages/components/communicationLib');

  it('splits and cleans address lists', () => {
    expect(lib.splitAddresses('a@x.com; <b@y.org>,\nc@z.io;;')).toEqual(['a@x.com', 'b@y.org', 'c@z.io']);
    expect(lib.splitAddresses(null)).toEqual([]);
    expect(lib.ADDR_RE.test('a.b@c.co')).toBe(true);
    expect(lib.ADDR_RE.test('a@b')).toBe(false);
    expect(lib.cleanName('Bakash, Alla [JRDUS NON-J&J]')).toBe('Bakash, Alla');
  });

  it('exposes the constants the Communication Center reads', () => {
    expect(lib.GRAPH).toBe('https://graph.microsoft.com/v1.0');
    for (const k of ['CLS', 'PLACEHOLDERS', 'ICON_TONES']) expect(Object.keys(lib[k]).length, k).toBeGreaterThan(0);
  });

  it('gets a directory token or says why not', async () => {
    await expect(lib.graphToken({}, [])).rejects.toThrow(/Sign in/);
    const instance = { acquireTokenSilent: vi.fn().mockResolvedValue({ accessToken: 't' }) };
    await expect(lib.graphToken(instance, [{ id: 1 }])).resolves.toBe('t');
  });

  it('searches the directory and falls back to startswith with quotes escaped', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(url);
      return calls.length === 1 ? { status: 400, ok: false } : { status: 200, ok: true, json: async () => ({ value: [] }) };
    });
    await lib.searchDirectory('tok', "O'Neil", 5);
    expect(calls[0]).toContain('$search=');
    expect(decodeURIComponent(calls[1])).toContain("startswith(displayName,'O''Neil')");
  });
});

describe('code highlighter', async () => {
  const { highlightCode } = await import('../src/pages/dataApi/highlight');

  it('colours tokens and never lets code become markup', () => {
    const html = highlightCode('import requests\nx = "<b>hi</b>"', 'python');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>');
    expect(html).toMatch(/<span class="[^"]*">import<\/span>/);
  });
});

describe('indexerLib', async () => {
  const lib = await import('../src/pages/dataStudio/indexerLib');

  it('formats what Index Health shows', () => {
    expect(lib.compact(1_234_567)).toBe('1.2M');
    expect(lib.compact(999)).toBe('999');
    expect(lib.compact(null)).toBe('?');
    expect(lib.plural(1, 'index', 'indexes')).toBe('1 index');
    expect(lib.plural(2, 'row')).toBe('2 rows');
    expect(lib.ago(null)).toBe('Never analyzed');
    expect(lib.ago(new Date(Date.now() - 3 * 864e5).toISOString())).toBe('3 days ago');
    expect(lib.msg({ detail: [{ msg: 'a' }, { msg: 'b' }] })).toBe('a; b');
    expect(lib.msg(new Error('boom'))).toBe('boom');
  });

  it('scores and titles findings', () => {
    expect(lib.scoreOf({ critical: 0, high: 0, redundant: 0, unused: 0 })).toBe(100);
    expect(lib.scoreOf({ critical: 9, high: 9, redundant: 9, unused: 9 })).toBe(6);
    expect(lib.titleOf({ feature: 'drop', id: 'drop:ix_a', status: 'unused' })).toBe('ix_a is never used');
    expect(lib.titleOf({ feature: 'filter', column: 'mrn' })).toBe('Lookups on mrn scan the whole table');
    expect(lib.featLabel('stats')).toBe('Refresh planner statistics');
    expect(lib.usageLists({ a: ['search'], b: ['filter', 'vector'] })).toEqual({ search: ['a'], filter: ['b'], vector: ['b'] });
    expect(lib.DIAG).toHaveLength(5);
  });
});

describe('permission keys', async () => {
  const { UNSTRUCTURED_TABS, UNSTRUCTURED_SUBTABS } = await import('../src/config/permissions');
  const authPy = readFileSync(resolve(repo, 'backend/auth.py'), 'utf8');

  it('every key exists in backend/auth.py', () => {
    const keys = [...Object.values(UNSTRUCTURED_TABS), ...Object.values(UNSTRUCTURED_SUBTABS).flatMap(Object.values)];
    for (const k of keys) expect(authPy, k).toContain(`"${k}"`);
  });
});

describe('repo wiring', () => {
  const read = (p) => readFileSync(resolve(repo, p), 'utf8');

  it('Header no longer pulls the whole Dashboard in for one constant', () => {
    expect(read('frontend/src/components/Header.jsx')).toMatch(/from "\.\.\/utils\/events"/);
    expect(read('frontend/src/pages/Dashboard.jsx')).not.toMatch(/export const PALETTE_EVENT/);
  });

  it('app shell has the skip link, main landmark and drawer wiring', () => {
    const app = read('frontend/src/App.jsx');
    expect(app).toContain('href="#main-content"');
    expect(app).toContain('id="main-content"');
    expect(app).toContain('h-[100dvh]');
    expect(app).toMatch(/drawerOpen=\{drawerOpen\}/);
  });

  it('page viewport covers notches; reduced motion is respected', () => {
    expect(read('frontend/index.html')).toContain('viewport-fit=cover');
    const css = read('frontend/src/index.css');
    expect(css).toContain('html.reduce-motion *');
    expect(css).toContain('.skip-link:focus');
  });

  it('assistant can navigate to every page the portal map knows', () => {
    const actions = read('frontend/src/assistant/assistantActions.js');
    for (const r of ['/pipeline-studio', '/about', '/rag/evaluation']) expect(actions).toContain(`'${r}':`);
  });

  it('no debug logging left in shipped code', () => {
    expect(read('frontend/src/hooks/useProfilePhoto.js')).not.toMatch(/console\.log\(/);
  });
});
