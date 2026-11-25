// The guided tour, loaded only when someone presses "Take the tour".
// It gets its helpers from IndCtaDataQuality.jsx through the `kit` prop.
import { useEffect, useLayoutEffect, useRef } from 'react';

// The film: a timeline of scenes plays over the live page; each scene
// sets the page up itself, so jumping to any chapter lands in the right state.
// Everything shown comes from the data passed in. Text only ever goes into the
// DOM through textContent.

const SVG = 'http://www.w3.org/2000/svg';

function h(tag, props, ...kids) {
  const el = tag.startsWith('svg:') ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag);
  Object.entries(props || {}).forEach(([k, v]) => {
    if (v == null || v === false) return;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  });
  kids.flat().forEach((c) => { if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c))); });
  return el;
}

const PLAYER = {
  play: '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/></svg>',
  prev: '<svg viewBox="0 0 16 16"><path d="M12.5 3v10L5 8z" fill="currentColor"/><rect x="3" y="3" width="2" height="10" rx="1" fill="currentColor"/></svg>',
  next: '<svg viewBox="0 0 16 16"><path d="M3.5 3v10L11 8z" fill="currentColor"/><rect x="11" y="3" width="2" height="10" rx="1" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};
// static icon markup, no data in it
const icon = (name) => { const s = h('span'); s.innerHTML = PLAYER[name]; return s.firstChild; };

const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

// evenly spread points for the title card network, no randomness needed
function netSvg(C, W, H, offset, density = 30) {
  const svg = h('svg:svg', { class: 'net', width: W, height: H });
  const n = Math.round(W / density);
  const pts = Array.from({ length: n }, (_, i) => {
    const j = i + offset;
    return [((j * 0.7548776662466927) % 1) * W, ((j * 0.5698402909980532) % 1) * H, (j * 0.6180339887) % 1];
  });
  let c = 0;
  pts.forEach((a, i) => pts.slice(i + 1).forEach((b) => {
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (d < 160) {
      svg.append(h('svg:line', {
        x1: a[0].toFixed(0), y1: a[1].toFixed(0), x2: b[0].toFixed(0), y2: b[1].toFixed(0), pathLength: 1,
        stroke: C.red, 'stroke-opacity': (0.16 * (1 - d / 160)).toFixed(3), style: { animationDelay: `${(c++ % 40) * 30}ms` },
      }));
    }
  }));
  pts.forEach(([x, y, k], i) => svg.append(h('svg:circle', {
    cx: x.toFixed(0), cy: y.toFixed(0), r: (1.4 + k * 1.8).toFixed(1), fill: k < 0.8 ? C.red : C.blue, 'fill-opacity': 0.5, style: { animationDelay: `${i * 15}ms` },
  })));
  return svg;
}

const chars = (text, d0 = 0, step = 38) => [...text].map((ch, i) => (ch === ' ' ? ' ' : h('span', { style: { animationDelay: `${d0 + i * step}ms` } }, ch)));
const words = (text, d0 = 0, step = 70) => text.split(' ').flatMap((w, i) => [i ? ' ' : null, h('span', { style: { animationDelay: `${d0 + i * step}ms` } }, w)]);

function createFilm(env) {
  const { root, content, scroller, setPage, onClose, data } = env;
  const { C, confOf, fmt, pct, plural, ruleLabel } = env.kit;
  const $ = (s) => (typeof s === 'string' ? document.querySelector(s) : s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const F = { i: 0, t: 0, playing: true, fired: 0, last: 0, raf: 0, focus: null, pad: 12, zoom: 1.25, spot: null, pins: [], cur: null, hoverEl: null, dock: 'center', timers: new Set() };

  const later = (fn, ms) => { const id = setTimeout(() => { F.timers.delete(id); fn(); }, ms); F.timers.add(id); };

  // ── stage pieces ──
  const spot = h('div', { class: 'f-spot' });
  // The dimmed page around the spotlight. Built from fixed-size pieces that only
  // ever move, so following a zooming target never repaints the whole screen.
  const shadeParts = ['t', 'b', 'l', 'r', 'c1', 'c2', 'c3', 'c4'].map((k) => h('i', { class: `fs-${k}` }));
  const shade = h('div', { class: 'f-shade' }, ...shadeParts);
  const RAD = 22;
  function drawShade(x, y, w, hh) {
    const vw = window.innerWidth, vh = window.innerHeight;
    x = Math.round(x); y = Math.round(y); w = Math.round(w); hh = Math.round(hh);
    const [t, b, l, r, c1, c2, c3, c4] = shadeParts;
    t.style.transform = `translate3d(0,${y - vh}px,0)`;
    b.style.transform = `translate3d(0,${y + hh}px,0)`;
    l.style.transform = `translate3d(${x - vw}px,${y}px,0) scaleY(${hh / 100})`;
    r.style.transform = `translate3d(${x + w}px,${y}px,0) scaleY(${hh / 100})`;
    c1.style.transform = `translate3d(${x}px,${y}px,0)`;
    c2.style.transform = `translate3d(${x + w - RAD}px,${y}px,0)`;
    c3.style.transform = `translate3d(${x}px,${y + hh - RAD}px,0)`;
    c4.style.transform = `translate3d(${x + w - RAD}px,${y + hh - RAD}px,0)`;
  }
  const lowerBox = h('div', { class: 'f-lower', 'aria-live': 'polite' });
  const cursor = h('div', { class: 'f-cursor' }, h('span', { class: 'rp' }));
  cursor.insertAdjacentHTML('beforeend', `<svg width="28" height="28" viewBox="0 0 28 28"><path d="M4 3l17 9.5-7.6 1.9L9.6 22z" fill="#fff" stroke="${C.text}" stroke-width="1.6" stroke-linejoin="round"/><path d="M4 3l17 9.5-7.6 1.9" fill="none" stroke="${C.red}" stroke-width="1.6" stroke-linejoin="round" opacity=".9"/></svg>`);
  const playBtn = h('button', { type: 'button', class: 'fb play', 'aria-label': 'Pause', onClick: () => setPlay(!F.playing) }, icon('pause'));
  const chap = h('div', { class: 'f-chap' });
  const time = h('div', { class: 'f-time num' });
  const segs = h('div', { class: 'f-segs' });
  const bar = h('div', { class: 'f-bar' },
    h('button', { type: 'button', class: 'fb', 'aria-label': 'Previous chapter', onClick: () => goScene(F.t > 1500 ? F.i : F.i - 1) }, icon('prev')),
    playBtn,
    h('button', { type: 'button', class: 'fb', 'aria-label': 'Next chapter', onClick: () => goScene(F.i + 1) }, icon('next')),
    chap, segs, time,
    h('button', { type: 'button', class: 'fb', 'aria-label': 'Close tour', onClick: () => onClose() }, icon('close')));
  const block = h('div', { class: 'f-block', title: 'Click to pause or play', onClick: () => setPlay(!F.playing) });
  root.append(block, shade, spot, lowerBox, cursor, bar);

  // ── camera: moves and scales the page content so the target sits in the free area ──
  function safeArea() {
    let top = (document.querySelector('.icq .topbar')?.getBoundingClientRect().bottom || 74) + 14;
    let bottom = window.innerHeight - 90;
    if (F.dock === 'center' && lowerBox.classList.contains('in')) {
      const r = lowerBox.getBoundingClientRect(), hh = (lowerBox.offsetHeight || 120) + 14;
      if (r.top < window.innerHeight / 2) top = Math.max(top, 12 + hh); else bottom -= hh;
    }
    // stay inside the page scroller, the app sidebar sits to its left
    const box = scroller?.getBoundingClientRect?.() || { left: 0, right: window.innerWidth };
    return { top, bottom, left: Math.max(16, box.left + 16), right: Math.min(window.innerWidth - 16, box.right - 16) };
  }
  // The page glides and zooms like a camera on every machine. The page sits on
  // its own layer for the whole tour, so each frame only moves a finished
  // picture and nothing gets repainted, which a CPU without a GPU keeps up with.
  const EASE = 'cubic-bezier(.45,0,.25,1)';
  if (content) content.style.willChange = 'transform';
  function camReset() {
    if (!content) return;
    Object.assign(content.style, { transition: `transform 1.1s ${EASE}`, transform: '' });
  }
  function camera(target, maxZoom = 1.25) {
    const el = $(target);
    F.focus = el; F.zoom = maxZoom;
    if (!el || !content?.contains(el)) { camReset(); return; }
    const m = new DOMMatrix(getComputedStyle(content).transform);
    const cur = { tx: m.e, ty: m.f, s: m.a || 1 };
    const r = el.getBoundingClientRect(), hr = content.getBoundingClientRect();
    const O = { x: hr.left - cur.tx, y: hr.top - cur.ty };
    const cx = O.x + (r.left + r.width / 2 - O.x - cur.tx) / cur.s, cy = O.y + (r.top + r.height / 2 - O.y - cur.ty) / cur.s;
    const w = r.width / cur.s, hh = r.height / cur.s, a = safeArea();
    const s = Math.max(0.5, Math.min(maxZoom, ((a.right - a.left) * 0.94) / w, ((a.bottom - a.top) * 0.92) / hh));
    const D = { x: (a.left + a.right) / 2, y: (a.top + a.bottom) / 2 };
    const tx = D.x - O.x - s * (cx - O.x), ty = D.y - O.y - s * (cy - O.y);
    Object.assign(content.style, { transformOrigin: '0 0', transition: `transform 1.3s ${EASE}`, transform: `translate(${tx}px,${ty}px) scale(${s})` });
  }
  function focusOn(target, pad = 12) {
    F.focus = $(target); F.pad = pad;
    if (!F.focus) { spot.classList.remove('on'); shade.classList.remove('on'); return; }
    spot.classList.add('on'); shade.classList.add('on');
    spot.querySelector('.f-scan')?.remove();
    later(() => spot.append(h('div', { class: 'f-scan' })), 900);
  }
  const shot = (target, zoom = 1.25, pad = 12) => { focusOn(target, pad); camera(target, zoom); };

  function pin(target, n, label, sub = '', anchor = 'r') {
    if (!$(target)) return;
    const node = h('div', { class: 'f-pin' }, h('span', { class: 'n' }, n), h('span', { class: 'l' }, label, sub ? h('small', null, sub) : null));
    root.append(node);
    F.pins.push({ target, node, anchor });
  }
  const clearPins = () => { F.pins.forEach((p) => p.node.remove()); F.pins = []; };

  function lower(num, chapter, title, body, dock = 'center') {
    F.dock = dock;
    lowerBox.classList.remove('in');
    later(() => {
      lowerBox.classList.toggle('left', dock === 'left');
      lowerBox.replaceChildren(
        h('div', { class: 'fl-k' }, h('b', null, num), h('span', null, chapter), h('i')),
        h('h3', null, words(title, 100)),
        h('p', null, body),
        h('div', { class: 'fl-prog' }, h('i')),
      );
      lowerBox.classList.add('in');
    }, 260);
  }
  function lowerBody(text) {
    const p = lowerBox.querySelector('p');
    if (!p) return;
    p.classList.remove('swap'); void p.offsetWidth; p.textContent = text; p.classList.add('swap');
  }
  const hideLower = () => { lowerBox.classList.remove('in'); F.dock = 'none'; };

  const cursorTo = (target, ox = 0.5, oy = 0.5) => { if (!$(target)) return; F.cur.el = target; F.cur.ox = ox; F.cur.oy = oy; cursor.classList.add('on'); };
  const cursorHide = () => { cursor.classList.remove('on'); F.cur.el = null; };
  function tap(target) {
    const el = $(target);
    if (!el) return false;
    cursor.classList.remove('click'); void cursor.offsetWidth; cursor.classList.add('click');
    later(() => { const n = $(target); if (n?.isConnected) n.click(); }, 160);
    return true;
  }
  function hover(target) {
    F.hoverEl?.classList.remove('f-hover');
    const el = $(target);
    F.hoverEl = el;
    if (el) { el.classList.add('f-hover'); cursorTo(el, 0.82, 0.6); }
  }
  const unhover = () => { F.hoverEl?.classList.remove('f-hover'); F.hoverEl = null; };

  function titleCard(kind) {
    root.querySelector('.f-title')?.remove();
    const W = window.innerWidth, H = window.innerHeight;
    let node;
    if (kind === 'intro') {
      const chips = [
        [C.red, fmt(data.open), 'open issues', 'fl1', { left: '9%', top: '24%' }],
        [C.green, pct(data.fixRate), 'already fixed', 'fl2', { right: '9%', top: '30%' }],
        [C.violet, fmt(data.totalRules), data.totalRules === 1 ? 'rule watching' : 'rules watching', 'fl3', { left: '14%', bottom: '20%' }],
      ];
      node = h('div', { class: 'f-title' }, netSvg(C, W, H, 5, 30),
        h('div', { class: 'ft-c' },
          h('div', { class: 'ft-brand' }, h('small', null, 'J&J Innovative Medicine'), h('b', null, 'GRA SmartHub')),
          h('div', { class: 'ft-kick' }, 'Guided tour · Data Quality Engine'),
          h('h1', null, chars('IND/CTA Data Quality', 500)),
          h('div', { class: 'ft-line' }),
          h('p', { class: 'ft-sub' }, 'Everything on this page, explained in about a minute.')),
        chips.map(([c, v, l, cls, pos]) => h('div', { class: `ft-chip ${cls}`, style: pos }, h('i', { style: { background: c } }), h('span', null, h('b', { class: 'num' }, v), h('br'), l))));
    } else {
      const key = (keys, strong, rest, delay) => h('div', { class: 'ft-key', style: { animationDelay: delay } }, keys.map((k) => h('kbd', null, k)), h('div', null, h('b', null, strong), rest));
      node = h('div', { class: 'f-title' }, netSvg(C, W, H, 9, 40),
        h('div', { class: 'ft-c' },
          h('div', { class: 'ft-kick', style: { marginTop: 0 } }, "That's the tour"),
          h('h1', null, chars('You’re ready.', 150, 45)),
          h('div', { class: 'ft-line' }),
          h('div', { class: 'ft-keys' },
            key(['/'], 'Search', ' any Source PK, value or rule in the issue explorer.', '.6s'),
            key(['←', '→'], 'Step', ' through issues without closing the panel.', '.75s'),
            key(['Esc'], 'Close', ' any panel, window or this tour.', '.9s')),
          h('div', { class: 'ft-btns' },
            h('button', { type: 'button', class: 'btn', onClick: () => { root.querySelector('.f-title')?.remove(); goScene(0); setPlay(true); } }, 'Watch again'),
            h('button', { type: 'button', class: 'btn primary', onClick: () => onClose() }, 'Start exploring'))));
    }
    root.insertBefore(node, bar);
  }
  function titleOut() {
    const t = root.querySelector('.f-title');
    if (!t) return;
    t.classList.add('out');
    later(() => t.remove(), 900);
  }

  // ── the script, written against what the data actually has ──
  const top = data.top;
  const closeN = data.closeCount;
  const busiestConf = data.scoredKeys.slice().sort((a, b) => (data.confMap[b] || 0) - (data.confMap[a] || 0))[0];
  const issueConf = data.confMap['POSSIBLE MATCH'] ? 'POSSIBLE MATCH' : busiestConf || '';
  const groupNames = data.groups.map((g) => g.group).filter(Boolean);
  const firstToggle = () => document.querySelector('#icq-map .tg[data-k]');
  const nth = (sel, i) => () => $$(sel)[i];
  // a row whose highlighted words are real differences makes the better example
  const diffRow = () => $$('tr.ir').find((r) => [...r.querySelectorAll('mark')].some((mk) => /[a-z]{2}/i.test(mk.textContent))) || $('tr.ir');
  const weeksBtn = (w) => () => $$('#icq-flow .seg button').find((b) => b.textContent.trim().startsWith(String(w)));
  const startActs = () => $$('#icq-start .act');

  const SCENES = [
    { name: 'Welcome', dur: 5200, cues: [
      [0, () => { setPage(); camReset(); focusOn(null); hideLower(); cursorHide(); titleCard('intro'); }],
      [4500, titleOut],
    ] },
    { name: 'The health check', dur: 8600, need: ['#icq-hero'], cues: [
      [0, () => { setPage(); root.querySelector('.f-title')?.remove(); lower('01', 'The health check', 'Is IND/CTA data getting better?', `${plural(data.open, 'issue')} are open right now and ${pct(data.fixRate)} of everything ever raised is fixed. The ring, the verdict and the sentence next to it update with every load.`); }],
      [350, () => shot('#icq-hero', 1.1, 10)],
      [1700, () => pin('#icq-hero .ringbox', 1, 'Share of every issue ever raised', 'that is now fixed')],
      [3400, () => pin('#icq-hero .status-pill', 2, 'Better or worse?', 'fixes vs new issues, last 4 weeks')],
      [5100, () => pin('#icq-gsplit', 3, groupNames.length > 1 ? groupNames.join(' vs ') : 'Each data group', 'click a group to see its issues', 'b')],
      [6900, () => lowerBody('Every number on this page is a door. Click it and you land on exactly those issues.')],
    ] },
    { name: 'Start here', dur: 7600, need: ['#icq-start .act'], cues: [
      [0, () => { setPage(); lower('02', 'Start here', 'Not sure where to begin?', 'These cards are picked fresh on every load and point to the work that moves the numbers most.'); shot('#icq-start', 1.35, 10); }],
      [1500, () => { const a = startActs().find((x) => x.dataset.act === 'top'); if (a) { hover(a); lowerBody(`The biggest hotspot right now is ${top.name}, with ${plural(top.open, 'open issue')}.`); } }],
      [2900, () => { const a = startActs().find((x) => x.dataset.act === 'quick'); if (a) { hover(a); lowerBody(`${plural(closeN, 'close match', 'close matches')} only differ in casing or spacing, so they clear fast.`); } }],
      [4400, () => { const a = startActs().find((x) => x.dataset.act === 'stuck'); if (a) { hover(a); lowerBody('A stuck rule keeps raising issues but nothing gets fixed. Worth a word with its owner.'); } }],
      [6500, () => { unhover(); cursorHide(); }],
    ] },
    { name: 'The numbers', dur: 8000, need: ['#icq-kpis'], cues: [
      [0, () => { setPage(); lower('03', 'The numbers that matter', 'Six live counters, each with a trend.', 'Red means attention, green means progress. The line under the first three is the last 12 weeks.'); shot('#icq-kpis', 1.2, 10); }],
      [1400, () => $$('#icq-kpis .kpi').forEach((k, i) => later(() => { k.classList.add('f-hover'); later(() => k.classList.remove('f-hover'), 520); }, i * 330))],
      [3900, () => cursorTo(nth('#icq-kpis .qmark', 1)())],
      [4800, () => { const q = nth('#icq-kpis .qmark', 1)(); if (q) { env.tip.showAt(q.dataset.tip, q); lowerBody('Not sure how something is counted? Hover the small (i) and it tells you.'); } }],
      [7200, () => { env.tip.hide(); cursorHide(); }],
    ] },
    { name: 'Backlog trend', dur: 9600, need: ['#icq-flow svg'], cues: [
      [0, () => { setPage(); lower('04', 'Is the backlog shrinking?', 'New in red, fixed in green, still open in blue.', `In the last 4 weeks ${plural(data.fixed4, 'issue')} got fixed and ${fmt(data.new4)} new ones came in. When green beats red, the blue line goes down.`); shot('#icq-flow', 1.3, 10); }],
      [1600, () => cursorTo(weeksBtn(52)())],
      [2500, () => tap(weeksBtn(52)())],
      [3000, () => lowerBody('Switch between 12, 26 and 52 weeks. A week far bigger than the rest is cut off so the others stay readable.')],
      [5300, () => { const w = $$('#icq-flow svg > g'); const g = w[w.length - 3]; if (g) cursorTo(g, 0.5, 0.25); }],
      [6200, () => { const w = $$('#icq-flow svg > g'); const g = w[w.length - 3]; if (g) { const r = g.getBoundingClientRect(); g.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 3 })); lowerBody('Hover any week for the exact numbers.'); } }],
      [8000, () => { env.tip.hide(); cursorTo(weeksBtn(26)()); }],
      [8800, () => tap(weeksBtn(26)())],
    ] },
    { name: 'Match confidence', dur: 9800, need: ['#icq-conf'], cues: [
      [0, () => { setPage(); lower('05', 'How hard is the fix?', 'Name rules compare JNJ values with EMA SMS.', `${plural(data.scoredTotal, 'open issue')} carry a match score, and each band tells you how much effort the fix takes.`); shot('#icq-conf', 1.25, 10); }],
      [1500, () => hover(nth('#icq-conf .band', 0)())],
      [2400, () => hover(nth('#icq-conf .band', 1)())],
      [3300, () => hover(nth('#icq-conf .band', 2)())],
      [4300, () => { unhover(); if ($('#icq-map svg')) { shot('#icq-map', 1.2, 10); lowerBody('On the map, each dot is one issue. Right means similar spelling, up means similar meaning.'); } }],
      [6000, () => cursorTo(firstToggle())],
      [6800, () => { if (tap(firstToggle())) lowerBody(`Click a band to hide it and see the rest more clearly. Here, ${confOf(firstToggle()?.dataset.k).label.toLowerCase()} is switched off.`); }],
      [8700, () => tap(firstToggle())],
    ] },
    { name: 'Rule hotspots', dur: 7000, need: ['#icq-hotspots .rrow'], cues: [
      [0, () => { setPage(); lower('06', 'Rule hotspots', 'Which rules hold the backlog?', top ? `${ruleLabel(top.id)} leads with ${plural(top.open, 'open issue')}. Each row shows how many came in this week and how fast they get fixed.` : 'The rules with the most open issues, how many came in this week and how fast they get fixed.'); shot('#icq-hotspots', 1.2, 10); }],
      [1600, () => hover(nth('#icq-hotspots .rrow', 0)())],
      [3200, () => { unhover(); pin('#icq-tabs [data-tab=rules]', 1, 'Every rule lives here', 'search, sort, trend per rule', 'b'); focusOn('#icq-tabs', 8); camReset(); lowerBody(`The Rules tab lists all ${fmt(data.totalRules)} of them, with progress, confidence and a 12 week trend.`); }],
      [6200, () => { clearPins(); cursorHide(); }],
    ] },
    { name: 'Drill down', dur: 9600, need: ['#icq-start .act'], cues: [
      [0, () => { setPage(); lower('07', 'One click to the details', 'Every card is a shortcut.', 'Click any card, band or rule and the issue explorer opens with the right filters already set.'); shot('#icq-start', 1.25, 10); }],
      [1300, () => cursorTo(startActs().at(-1), 0.8, 0.55)],
      [2200, () => tap(startActs().at(-1))],
      [2900, () => { cursorHide(); shot('.icq .iss', 1, 10); }],
      [3700, () => pin('#icq-chips', 1, 'Your filters', 'click one to remove it')],
      [5100, () => pin('#icq-rail', 2, 'Narrow it down', 'counts update as you go', 'tl')],
      [6500, () => pin('#icq-iq', 3, 'Search anything', 'press / to jump here', 'b')],
      [8000, () => lowerBody('Highlighted words in the table are exactly what differs between JNJ and EMA SMS.')],
    ] },
    { name: 'Inside an issue', dur: 11000, cues: [
      [0, () => { setPage({ tab: 'issues', f: { conf: issueConf } }); shot('.icq .iss', 1, 10); lower('08', 'Inside an issue', 'Click a row to open it.', 'Match scores, both values side by side, a plain-English verdict and the full history.'); }],
      [1200, () => cursorTo(diffRow(), 0.3, 0.5)],
      [2000, () => { if (!tap(diffRow())) goScene(F.i + 1); }],
      [2500, () => { cursorHide(); camReset(); lower('08', 'Inside an issue', 'How close are the two values?', 'Scores show how alike they are, in spelling and in meaning.', 'left'); }],
      [2900, () => focusOn($('.icq .drawer .gauges') ? '.icq .drawer .gauges' : '.icq .drawer .plain', 10)],
      [4700, () => { if ($('.icq .drawer .cmp')) { focusOn('.icq .drawer .cmp', 10); lowerBody('JNJ on the left, EMA SMS on the right. Highlighted words are the ones that do not match.'); } }],
      [6700, () => { if ($('.icq .drawer .plain')) { focusOn('.icq .drawer .plain', 10); lowerBody('Every issue explains itself in plain words and suggests the likely fix.'); } }],
      [8400, () => { const n = $('.icq .drawer [aria-label="Next issue"]:not([disabled])'); if (n) { cursorTo(n); lowerBody('Use the arrows, or ← → on your keyboard, to move to the next issue.'); } }],
      [9300, () => tap('.icq .drawer [aria-label="Next issue"]:not([disabled])')],
      [9700, () => { cursorHide(); focusOn($('.icq .drawer .gauges') ? '.icq .drawer .gauges' : '.icq .drawer .plain', 10); }],
    ] },
    { name: 'You’re ready', dur: 3000, cues: [
      [0, () => { setPage(); camReset(); focusOn(null); clearPins(); hideLower(); cursorHide(); titleCard('outro'); }],
    ] },
  ];
  SCENES.forEach((s) => s.cues.sort((a, b) => a[0] - b[0]));
  const TOTAL = SCENES.reduce((s, x) => s + x.dur, 0);
  const startOf = (i) => SCENES.slice(0, i).reduce((s, x) => s + x.dur, 0);

  SCENES.forEach((s, i) => {
    const b = h('button', { type: 'button', class: 'f-seg', title: s.name, 'aria-label': `Chapter ${i + 1}: ${s.name}`, style: { flex: s.dur }, onClick: () => goScene(i) }, h('i'));
    segs.append(b);
  });
  const segFills = [...segs.querySelectorAll('i')];

  // ── player ──
  function setPlay(on) {
    F.playing = on;
    playBtn.replaceChildren(icon(on ? 'pause' : 'play'));
    playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
  }
  function goScene(i) {
    i = Math.max(0, Math.min(SCENES.length - 1, i));
    clearPins(); unhover(); env.tip.hide(); cursorHide();
    F.shownScene = -1;
    if (i !== 0 && i !== SCENES.length - 1) root.querySelector('.f-title')?.remove();
    F.i = i; F.t = 0; F.fired = 0;
    SCENES[i].checked = false;
    if (i === SCENES.length - 1 || !F.playing) setPlay(true);
  }
  // a scene whose pieces are not on the page (no data, empty group) is skipped
  function checkNeeds() {
    const sc = SCENES[F.i];
    if (!sc.need || sc.checked) return;
    sc.checked = true;
    if (sc.need.some((s) => !document.querySelector(s))) goScene(F.i + 1);
  }
  // Every frame: read all the rects first, then write, so the browser lays out once.
  // Writes are skipped when nothing moved more than a fraction of a pixel.
  const moved = (a, b) => !a || Math.abs(a.x - b.x) > 0.3 || Math.abs(a.y - b.y) > 0.3 || Math.abs((a.w || 0) - (b.w || 0)) > 0.3 || Math.abs((a.h || 0) - (b.h || 0)) > 0.3;
  function follow(dt) {
    const k = 1 - (1 - 0.14) ** (dt / 16.7), kc = 1 - (1 - 0.1) ** (dt / 16.7);
    const vw = window.innerWidth;
    const f = F.focus && F.focus.isConnected ? F.focus.getBoundingClientRect() : null;
    const pins = F.pins.map((pn) => {
      const el = $(typeof pn.target === 'function' ? pn.target() : pn.target);
      if (!el || !el.isConnected) return null;
      if (!pn.w) pn.w = pn.node.offsetWidth;
      return el.getBoundingClientRect();
    });
    const c = F.cur;
    const cel = $(typeof c.el === 'function' ? c.el() : c.el);
    const cr = cel && cel.isConnected ? cel.getBoundingClientRect() : null;

    if (f) {
      const p = F.pad || 12;
      const tgt = { x: f.left - p, y: f.top - p, w: f.width + p * 2, h: f.height + p * 2 };
      const s0 = F.spot || tgt;
      const next = { x: s0.x + (tgt.x - s0.x) * k, y: s0.y + (tgt.y - s0.y) * k, w: s0.w + (tgt.w - s0.w) * k, h: s0.h + (tgt.h - s0.h) * k };
      if (moved(F.drawn, next)) {
        spot.style.transform = `translate(${next.x.toFixed(1)}px,${next.y.toFixed(1)}px)`;
        if (!F.drawn || Math.abs(F.drawn.w - next.w) > 0.3 || Math.abs(F.drawn.h - next.h) > 0.3) {
          spot.style.width = `${next.w.toFixed(1)}px`;
          spot.style.height = `${next.h.toFixed(1)}px`;
        }
        drawShade(next.x, next.y, next.w, next.h);
        F.drawn = next;
      }
      F.spot = next;
    }
    F.pins.forEach((pn, i) => {
      const r = pins[i];
      if (!r) { if (pn.shown !== false) { pn.node.style.opacity = 0; pn.shown = false; } return; }
      const w = pn.w;
      let x, y;
      if (pn.anchor === 'b') { x = r.left + r.width / 2 - 15; y = r.bottom + 10; }
      else if (pn.anchor === 'tl') { x = r.left + 10; y = r.top + 10; }
      else { x = r.right - 15; y = r.top + r.height / 2 - 15; }
      const flip = x + w > vw - 16;
      if (flip) x = x - w + 30;
      x = Math.max(8, Math.min(vw - w - 8, x));
      if (pn.flip !== flip) { pn.node.classList.toggle('flip', flip); pn.flip = flip; }
      if (pn.shown !== true) { pn.node.style.opacity = 1; pn.shown = true; }
      if (moved(pn.at, { x, y })) { pn.node.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`; pn.at = { x, y }; }
    });
    if (cr) {
      const tx = cr.left + cr.width * c.ox, ty = cr.top + cr.height * c.oy;
      c.x += (tx - c.x) * kc; c.y += (ty - c.y) * kc;
    }
    if (moved(c.at, { x: c.x, y: c.y })) { cursor.style.transform = `translate(${(c.x - 4).toFixed(1)}px,${(c.y - 3).toFixed(1)}px)`; c.at = { x: c.x, y: c.y }; }
  }
  function loop(now) {
    const dt = Math.min(64, now - F.last); F.last = now;
    const sc = SCENES[F.i];
    if (F.playing) {
      F.t += dt;
      while (F.fired < sc.cues.length && sc.cues[F.fired][0] <= F.t) {
        try { sc.cues[F.fired][1](); } catch (e) { console.warn('tour cue failed', e); }
        F.fired++;
        if (SCENES[F.i] !== sc) break;
      }
      if (SCENES[F.i] === sc && F.t >= 250) checkNeeds();
      if (SCENES[F.i] === sc && F.t >= sc.dur) {
        if (F.i < SCENES.length - 1) goScene(F.i + 1);
        else { F.t = sc.dur; setPlay(false); }
      }
    }
    follow(dt);
    const cur = SCENES[F.i];
    const part = Math.min(1, F.t / cur.dur);
    if (F.shownScene !== F.i) {
      F.shownScene = F.i;
      chap.replaceChildren(cur.name, h('small', null, `Chapter ${F.i + 1} of ${SCENES.length}`));
      segFills.forEach((n, i) => { n.style.transform = `scaleX(${i < F.i ? 1 : 0})`; });
    }
    segFills[F.i].style.transform = `scaleX(${part.toFixed(4)})`;
    const label = `${mmss(startOf(F.i) + Math.min(F.t, cur.dur))} / ${mmss(TOTAL)}`;
    if (label !== F.label) { time.textContent = label; F.label = label; }
    if (!F.prog?.isConnected) F.prog = lowerBox.querySelector('.fl-prog i');
    if (F.prog) F.prog.style.transform = `scaleX(${part.toFixed(4)})`;
    F.raf = requestAnimationFrame(loop);
  }

  // keys belong to the player while it is open
  const onKey = (e) => {
    e.stopImmediatePropagation();
    if (e.key === ' ' || e.key === 'k') { if (e.target.closest?.('button')) return; e.preventDefault(); setPlay(!F.playing); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); goScene(F.i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); goScene(F.t > 1500 ? F.i : F.i - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };
  document.addEventListener('keydown', onKey, true);

  let resizeT;
  const onResize = () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (F.focus && content?.contains(F.focus)) camera(F.focus, F.zoom); }, 150); };
  window.addEventListener('resize', onResize);

  // start
  scroller?.scrollTo?.(0, 0);
  F.cur = { x: window.innerWidth * 0.6, y: window.innerHeight * 0.7, el: null, ox: 0.5, oy: 0.5 };
  F.last = performance.now();
  goScene(0);
  bar.querySelector('.fb.play')?.focus({ preventScroll: true });
  F.raf = requestAnimationFrame(loop);

  return function destroy() {
    cancelAnimationFrame(F.raf);
    F.timers.forEach(clearTimeout);
    clearTimeout(resizeT);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    unhover();
    env.tip.hide();
    root.replaceChildren();
    if (content) Object.assign(content.style, { transition: '', transform: '', transformOrigin: '', willChange: '' });
  };
}

const PAGE_KEYS = ['indctatab', 'weeks', 'status', 'group', 'rule', 'conf', 'q', 'days', 'age', 'sort', 'dir', 'page', 'size', 'rq', 'rgroup', 'rsort', 'issue', 'irule'];

export default function Tour({ url, m, summary, scroller, content, kit, onClose }) {
  const { DEFAULT_FILTERS, defaultSort, writeFilters, lockScroll, useTip, useToast } = kit;
  const box = useRef(null);
  const tip = useTip();
  const toast = useToast();
  const saved = useRef(null);
  const started = useRef(false);
  const live = useRef({ url, onClose });
  live.current = { url, onClose };

  // remember where the user was, and put it all back when the tour ends
  if (!saved.current) saved.current = { snap: url.snapshot(), y: scroller?.scrollTop || 0 };
  useLayoutEffect(() => {
    const u = live.current.url;
    u.replaceAll.current = true;
    const unlock = lockScroll(scroller);
    const { snap, y } = saved.current;
    return () => {
      u.replaceAll.current = false;
      u.restore(snap);
      unlock();
      requestAnimationFrame(() => requestAnimationFrame(() => scroller?.scrollTo?.(0, y)));
    };
  }, [scroller, lockScroll]);

  // a scene asks for a page state; it is written over the current URL entry
  const setPage = (o = {}) => {
    const p = new URLSearchParams(window.location.search);
    PAGE_KEYS.forEach((k) => p.delete(k));
    if (o.tab && o.tab !== 'overview') p.set('indctatab', o.tab);
    const f = { ...DEFAULT_FILTERS, ...(o.f || {}) };
    f.sort = defaultSort(f.status);
    writeFilters(p, f);
    if (p.toString() !== window.location.search.replace(/^\?/, '')) live.current.url.restore(p.toString());
  };

  useEffect(() => {
    if (summary.error && !summary.data) {
      toast('The tour needs the page numbers, and they did not load.', true);
      live.current.onClose();
    }
  }, [summary.error, summary.data, toast]);

  // wait for the numbers, then roll
  useEffect(() => {
    if (!m || started.current || !box.current) return undefined;
    started.current = true;
    const destroy = createFilm({ root: box.current, content: content.current, scroller, setPage, tip, kit, data: m, onClose: () => live.current.onClose() });
    return () => { destroy(); started.current = false; };
    // the film keeps the data it started with
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!m]);

  useEffect(() => {
    if (m) return undefined;
    const key = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); live.current.onClose(); } };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [m]);

  return (
    <div className="film" role="dialog" aria-modal="true" aria-label="Guided tour">
      <style>{TOUR_CSS}</style>
      <div ref={box} />
      {!m && (
        <div className="f-title">
          <div className="ft-c">
            <div className="ft-kick" style={{ marginTop: 0 }}>Guided tour</div>
            <div className="ft-wait"><span className="spin" />Getting the latest numbers</div>
            <div className="ft-btns"><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

const TOUR_CSS = `
/* film tour: plays over the live page like a short motion graphics video */
.icq .film{position:fixed;inset:0;z-index:95;pointer-events:none;font-family:var(--ft)}
.icq .film .f-block{position:absolute;inset:0;pointer-events:auto;cursor:pointer}
.icq .f-spot{position:fixed;left:0;top:0;border-radius:22px;pointer-events:none;opacity:0;transition:opacity .6s}
.icq .f-shade{position:fixed;inset:0;pointer-events:none;opacity:0;transition:opacity .6s;overflow:hidden;--dim:rgba(247,245,242,.86)}
.icq .f-shade.on{opacity:1}
.icq .f-shade i{position:absolute;left:0;top:0;display:block;background:var(--dim);will-change:transform;transform-origin:0 0}
.icq .f-shade .fs-t,.icq .f-shade .fs-b{width:100vw;height:100vh}
.icq .f-shade .fs-l,.icq .f-shade .fs-r{width:100vw;height:100px}
.icq .f-shade .fs-c1,.icq .f-shade .fs-c2,.icq .f-shade .fs-c3,.icq .f-shade .fs-c4{width:22px;height:22px;background:none}
.icq .f-shade .fs-c1{background:radial-gradient(circle at 100% 100%,transparent 21.5px,var(--dim) 22px)}
.icq .f-shade .fs-c2{background:radial-gradient(circle at 0 100%,transparent 21.5px,var(--dim) 22px)}
.icq .f-shade .fs-c3{background:radial-gradient(circle at 100% 0,transparent 21.5px,var(--dim) 22px)}
.icq .f-shade .fs-c4{background:radial-gradient(circle at 0 0,transparent 21.5px,var(--dim) 22px)}
.icq .f-spot.on{opacity:1}
.icq .f-spot,.icq .f-pin,.icq .f-cursor{will-change:transform}
.icq .f-spot::after{content:"";position:absolute;inset:-3px;border-radius:24px;border:2px solid var(--red);box-shadow:0 0 0 8px rgba(235,23,0,.07),0 0 44px rgba(235,23,0,.22);animation:icqSpotGlow 2.8s cubic-bezier(.45,0,.25,1) infinite}
@keyframes icqSpotGlow{0%,100%{opacity:.7}50%{opacity:1}}
.icq .f-scan{position:absolute;inset:0;border-radius:22px;overflow:hidden}
.icq .f-scan::before{content:"";position:absolute;top:0;bottom:0;width:30%;left:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);transform:translateX(-100%);animation:icqScan 1.1s cubic-bezier(.65,0,.35,1) both}
@keyframes icqScan{to{transform:translateX(370%)}}

.icq .f-pin{position:fixed;left:0;top:0;display:flex;align-items:center;gap:10px;pointer-events:none}
.icq .f-pin.flip{flex-direction:row-reverse}
.icq .f-pin .n{width:30px;height:30px;border-radius:50%;background:var(--red);color:#fff;font:700 13px var(--fd);display:flex;align-items:center;justify-content:center;box-shadow:0 10px 22px -8px rgba(235,23,0,.7);position:relative;flex:none;animation:icqPinPop .6s cubic-bezier(.34,1.3,.64,1) both}
.icq .f-pin .n::before{content:"";position:absolute;inset:-7px;border-radius:50%;border:2px solid rgba(235,23,0,.35);animation:icqPulse 1.9s ease-out infinite}
.icq .f-pin .l{background:#fff;border:1px solid var(--line);border-radius:12px;padding:8px 12px;font-size:13px;font-weight:700;color:var(--text);box-shadow:0 18px 36px -18px rgba(49,44,42,.5);white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis;animation:icqLabelIn .5s .18s cubic-bezier(.2,.7,.2,1) both}
.icq .f-pin .l small{display:block;font-weight:400;color:var(--muted);font-size:12px;margin-top:1px}
.icq .f-pin.flip .l{animation-name:icqLabelInL}
@keyframes icqPinPop{from{transform:scale(0) rotate(-20deg)}to{transform:none}}
@keyframes icqLabelIn{from{opacity:0;transform:translateX(-10px);clip-path:inset(0 100% 0 0)}to{opacity:1;transform:none;clip-path:inset(0)}}
@keyframes icqLabelInL{from{opacity:0;transform:translateX(10px);clip-path:inset(0 0 0 100%)}to{opacity:1;transform:none;clip-path:inset(0)}}

.icq .f-lower{position:fixed;left:50%;bottom:90px;width:min(780px,calc(100vw - 32px));transform:translateX(-50%);pointer-events:none;
  background:rgba(255,255,255,.95);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid var(--line);border-radius:20px;
  padding:18px 24px 18px 30px;box-shadow:0 30px 70px -30px rgba(49,44,42,.45);overflow:hidden;opacity:0;transition:opacity .35s,transform .5s cubic-bezier(.2,.7,.2,1),left .6s cubic-bezier(.65,0,.35,1),width .6s}
.icq .f-lower.in{opacity:1}
.icq .f-lower.left{left:24px;transform:none;width:max(340px,min(500px,calc(100vw - 760px)))}
.icq .f-lower::before{content:"";position:absolute;left:0;top:0;bottom:0;width:5px;background:linear-gradient(var(--red),var(--orange))}
.icq .fl-k{display:flex;align-items:center;gap:12px}
.icq .fl-k b{font:300 30px/1 var(--fd);color:var(--red);letter-spacing:-.02em}
.icq .fl-k span{font-size:11px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:var(--faint)}
.icq .fl-k i{flex:1;height:1px;background:linear-gradient(90deg,var(--line2),transparent)}
.icq .f-lower h3{font:700 22px/1.25 var(--fd);margin-top:8px;letter-spacing:-.01em}
.icq .f-lower h3 span{display:inline-block;animation:icqWordIn .6s cubic-bezier(.2,.7,.2,1) both}
.icq .f-lower p{margin:6px 0 0;font-size:14.5px;line-height:1.55;color:var(--body);animation:icqRise .6s .35s both}
.icq .f-lower p.swap{animation:icqRise .5s both}
@keyframes icqWordIn{from{opacity:0;transform:translateY(45%)}to{opacity:1;transform:none}}
.icq .fl-prog{position:absolute;left:0;right:0;bottom:0;height:3px;background:var(--tint)}
.icq .fl-prog i{display:block;height:100%;width:100%;background:var(--red);opacity:.6;transform:scaleX(0);transform-origin:left}

.icq .f-cursor{position:fixed;left:0;top:0;width:28px;height:28px;pointer-events:none;opacity:0;transition:opacity .4s;filter:drop-shadow(0 8px 12px rgba(49,44,42,.28))}
.icq .f-cursor.on{opacity:1}
.icq .f-cursor svg{display:block;transition:transform .15s;transform-origin:4px 3px}
.icq .f-cursor .rp{position:absolute;left:-16px;top:-16px;width:36px;height:36px;border-radius:50%;border:2px solid var(--red);opacity:0}
.icq .f-cursor.click svg{transform:scale(.82)}
.icq .f-cursor.click .rp{animation:icqRipple .65s ease-out}
@keyframes icqRipple{from{transform:scale(.25);opacity:1}to{transform:scale(2.3);opacity:0}}
.icq .f-hover{box-shadow:0 0 0 3px rgba(235,23,0,.22),0 16px 34px -18px rgba(235,23,0,.55) !important;transform:translateY(-2px);transition:box-shadow .3s,transform .3s !important}

.icq .f-title{position:fixed;inset:0;pointer-events:auto;display:flex;align-items:center;justify-content:center;overflow:hidden;
  background:radial-gradient(900px 500px at 80% 0%,rgba(235,23,0,.09),transparent 70%),radial-gradient(800px 500px at 0% 100%,rgba(105,208,255,.14),transparent 70%),radial-gradient(600px 400px at 10% 10%,rgba(251,224,88,.14),transparent 70%),#fbfaf8;animation:icqFade .5s both}
.icq .f-title.out{animation:icqTitleOut .9s cubic-bezier(.65,0,.35,1) forwards;pointer-events:none}
@keyframes icqTitleOut{to{opacity:0;transform:scale(1.04)}}
.icq .f-title .net{position:absolute;inset:0}
.icq .f-title .net line{stroke-dasharray:1;stroke-dashoffset:1;animation:icqDrawLine 1.6s ease forwards}
@keyframes icqDrawLine{to{stroke-dashoffset:0}}
.icq .f-title .net circle{animation:icqPinPop .6s both}
.icq .ft-c{position:relative;text-align:center;padding:0 24px;isolation:isolate}
.icq .ft-c::before{content:"";position:absolute;inset:-90px -160px;background:radial-gradient(closest-side,#fbfaf8 62%,rgba(251,250,248,0));z-index:-1}
.icq .ft-brand{display:inline-flex;flex-direction:column;align-items:center;color:var(--red);line-height:1.05;animation:icqRise .7s .1s both}
.icq .ft-brand small{font-weight:700;font-size:12px}
.icq .ft-brand b{font:700 22px var(--fd);margin-top:3px}
.icq .ft-kick{margin-top:34px;font-size:12px;font-weight:700;letter-spacing:.34em;text-transform:uppercase;color:var(--red);animation:icqRise .7s .35s both}
.icq .f-title h1{font:500 clamp(42px,6.4vw,92px)/1.02 var(--fd);letter-spacing:.01em;margin-top:14px;color:var(--text)}
.icq .f-title h1 span{display:inline-block;animation:icqCharIn .8s cubic-bezier(.2,.7,.2,1) both}
@keyframes icqCharIn{from{opacity:0;transform:translateY(40%) rotate(4deg)}to{opacity:1;transform:none}}
.icq .ft-line{height:3px;width:0;margin:24px auto 0;border-radius:3px;background:linear-gradient(90deg,var(--red),var(--orange));animation:icqLineGrow 1s 1.3s cubic-bezier(.65,0,.35,1) forwards}
@keyframes icqLineGrow{to{width:120px}}
.icq .ft-sub{margin:20px auto 0;font-size:17px;color:var(--body);max-width:560px;line-height:1.55;animation:icqRise .8s 1.6s both}
.icq .ft-chip{position:absolute;display:flex;align-items:center;gap:10px;background:#fff;border:1px solid var(--line);border-radius:16px;padding:12px 16px;box-shadow:0 24px 50px -26px rgba(49,44,42,.45)}
.icq .ft-chip b{font:700 24px var(--fd)}
.icq .ft-chip span{font-size:12px;color:var(--muted);line-height:1.3;text-align:left}
.icq .ft-chip i{width:10px;height:10px;border-radius:50%}
@keyframes icqChipIn{from{opacity:0;transform:translateY(40px) scale(.85)}to{opacity:1;transform:none}}
.icq .ft-chip.fl1{animation:icqChipIn 1s 1.8s both,icqFloat1 9s 2.8s ease-in-out infinite}
.icq .ft-chip.fl2{animation:icqChipIn 1s 2.05s both,icqFloat2 10s 3s ease-in-out infinite}
.icq .ft-chip.fl3{animation:icqChipIn 1s 2.3s both,icqFloat1 11s 3.3s ease-in-out infinite}
.icq .ft-keys{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:30px auto 0;max-width:720px}
.icq .ft-key{background:#fff;border:1px solid var(--line);border-radius:16px;padding:16px;text-align:left;box-shadow:0 18px 40px -28px rgba(49,44,42,.4);animation:icqRise .7s both}
.icq .ft-key kbd{display:inline-flex;min-width:30px;height:30px;padding:0 9px;align-items:center;justify-content:center;border-radius:8px;background:var(--soft);border:1px solid var(--line2);border-bottom-width:3px;font:700 13px var(--ft);color:var(--text);margin-right:4px}
.icq .ft-key div{margin-top:10px;font-size:13px;color:var(--body);line-height:1.45}
.icq .ft-key b{color:var(--text)}
.icq .ft-btns{display:flex;gap:10px;justify-content:center;margin-top:30px;animation:icqRise .7s 1s both}
.icq .ft-btns .btn{height:44px;padding:0 20px;font-size:14px}
.icq .ft-wait{display:flex;align-items:center;gap:10px;justify-content:center;margin-top:26px;font-size:14px;color:var(--body)}

.icq .f-bar{position:fixed;left:0;right:0;margin:0 auto;bottom:18px;width:min(820px,calc(100vw - 32px));display:flex;align-items:center;gap:8px;padding:8px 12px 8px 8px;border-radius:18px;
  background:rgba(255,255,255,.96);border:1px solid var(--line);box-shadow:0 24px 60px -24px rgba(49,44,42,.45);pointer-events:auto;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);animation:icqRise .6s .2s both;z-index:2}
.icq .fb{width:38px;height:38px;border-radius:11px;border:none;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text);flex:none;transition:background .15s}
.icq .fb:hover{background:var(--tint)}
.icq .fb.play{background:var(--red);color:#fff;box-shadow:0 10px 22px -12px rgba(235,23,0,.7)}
.icq .fb.play:hover{background:#d41500}
.icq .fb svg{width:15px;height:15px}
.icq .f-chap{font-size:12.5px;font-weight:700;white-space:nowrap;width:150px;overflow:hidden;text-overflow:ellipsis;margin-left:4px}
.icq .f-chap small{display:block;font-weight:400;color:var(--faint);font-size:11px}
.icq .f-segs{flex:1;display:flex;gap:4px;align-items:center;height:38px;min-width:120px}
.icq .f-seg{height:5px;border-radius:9px;background:var(--tint);position:relative;overflow:hidden;cursor:pointer;transition:height .15s;border:none;padding:0}
.icq .f-segs:hover .f-seg{height:9px}
.icq .f-seg i{position:absolute;left:0;top:0;bottom:0;background:var(--red);width:100%;transform:scaleX(0);transform-origin:left}
.icq .f-time{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;min-width:78px;text-align:right}
@media (max-width:760px){.icq .f-chap,.icq .f-time{display:none} .icq .f-lower,.icq .f-lower.left{top:12px;bottom:auto;padding:14px 16px 14px 22px} .icq .f-lower h3{font-size:18px} .icq .f-lower p{font-size:13px} .icq .f-lower.left{left:16px;width:calc(100vw - 32px)} .icq .ft-keys{grid-template-columns:1fr} .icq .ft-chip{display:none} .icq .f-pin .l{max-width:180px}}
/* without a GPU: same graphics, the caption and player get a solid panel instead
   of a live blur (the page moves under them every frame, so blur would repaint) */
.icq.lite .f-lower,.icq.lite .f-bar{backdrop-filter:none;-webkit-backdrop-filter:none;background:#fff}
.icq.lite .f-lower{transition-property:opacity,transform,left,width !important}
.icq.lite .ft-line{width:120px;transform-origin:center;animation:icqGrow 1s 1.3s cubic-bezier(.22,1,.36,1) both}
`;