import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, CircleCheck, Copy, Download, Info, KeyRound, Link2, Loader2,
  LogOut, Maximize2, Play, RotateCcw, Search, Square, TriangleAlert, UserPlus, Users, X,
} from 'lucide-react';
import { usePeers } from './collab';
import { useMsal } from '@azure/msal-react';
import { graphToken, searchDirectory } from '../../components/communicationLib';
import { useDirectoryPhotos } from '../../../hooks/useDirectoryPhotos';
import { cellText, TOKEN_COLORS, tokenizeSql } from '../shared/studioHelpers';
import { firstName, fmtMs, fmtN, formatSql, MOD, plural, sigVars, T, useEngine } from './paneLib';

// Snowflake errors look like:
//   "001003 (42000): SQL compilation error:\nsyntax error line 2 at position 5 unexpected 'FORM'."
// Pull out the code, state and position so the panel can point at the line.
function parseSfError(raw) {
  const text = String(raw || '').trim();
  const head = /^(\d{6})\s*\((\w{5})\):\s*/.exec(text);
  const body = head ? text.slice(head[0].length) : text;
  let pos = /line\s+(\d+)\s+at\s+position\s+(\d+)/i.exec(body);
  const pg = !pos && /^LINE (\d+): .*\n( *)\^/m.exec(body);
  if (pg) pos = [null, pg[1], Math.max(1, pg[2].length - `LINE ${pg[1]}: `.length + 1)];
  // Multi-statement runs end with "Statement 3 of 5, starting on line 12." and the
  // line above is counted inside that statement.
  const at = /Statement \d+ of \d+, starting on line (\d+)\.\s*$/.exec(body);
  if (pos && at) pos = [null, Number(pos[1]) + Number(at[1]) - 1, pos[2]];
  const firstBreak = body.indexOf('\n');
  let title = firstBreak > 0 ? body.slice(0, firstBreak) : body;
  let detail = firstBreak > 0 ? body.slice(firstBreak + 1).trim() : '';
  if (title.length > 140 && !detail) { detail = title; title = 'Query failed'; }
  return {
    code: head?.[1] || null,
    state: head?.[2] || null,
    title: title.replace(/:$/, '') || 'Query failed',
    detail,
    line: pos ? Number(pos[1]) : null,
    col: pos ? Number(pos[2]) : null,
    raw: text,
  };
}

/* ------------------------------ primitives ------------------------------ */

const BTN = {
  primary: 'bg-[#eb1700] text-white hover:bg-[#c51300] border border-transparent shadow-[0_1px_2px_rgba(49,44,42,.18)]',
  danger: 'bg-[#9e0000] text-white hover:bg-[#7f0000] border border-transparent',
  dark: 'bg-[#312c2a] text-white hover:bg-[#1f1b1a] border border-transparent',
  secondary: 'bg-white text-[#312c2a] border border-[#d5cfc9] hover:bg-[#f4f2f0] hover:border-[#cbc4bc]',
  ghost: 'bg-transparent text-[#4a423e] border border-transparent hover:bg-[#f1efed]',
};

export function Button({ variant = 'secondary', size = 'md', icon, children, className = '', ...rest }) {
  const IconCmp = icon;
  const h = size === 'sm' ? 'h-6 px-2 text-[11.5px] gap-1' : 'h-7 px-2.5 text-[12px] gap-1.5';
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sig-ring)] disabled:opacity-45 disabled:cursor-not-allowed ${h} ${BTN[variant]} ${className}`}
    >
      {IconCmp && <IconCmp size={size === 'sm' ? 12 : 13} strokeWidth={2} className="flex-shrink-0" />}
      {children}
    </button>
  );
}

export function IconButton({ icon, label, active, size = 26, className = '', iconSize = 14, ...rest }) {
  const IconCmp = icon;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      {...rest}
      style={{ width: size, height: size }}
      className={`inline-flex items-center justify-center flex-shrink-0 rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sig-ring)] disabled:opacity-40 ${
        active ? 'bg-[var(--sig-soft)] text-[var(--sig-ink)]' : 'text-[#6e6259] hover:bg-[#f1efed] hover:text-[#312c2a]'
      } ${className}`}
    >
      <IconCmp size={iconSize} strokeWidth={1.9} />
    </button>
  );
}

// Small icon button for the editor's own toolbar, dark or light to match it.
export function EdTool({ dark, icon, label, className = '', ...rest }) {
  const IconCmp = icon;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      {...rest}
      className={`inline-flex items-center justify-center w-[26px] h-[24px] rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sig-ring)] disabled:opacity-35 disabled:cursor-not-allowed ${
        dark ? 'text-[#a39992] hover:bg-[#352f2c] hover:text-white' : 'text-[#6e6259] hover:bg-[#f1efed] hover:text-[#312c2a]'} ${className}`}
    >
      <IconCmp size={14} strokeWidth={1.9} />
    </button>
  );
}

// Foot of the editor: run it, see it going, see how long it took.
// Statements whose "rows affected" means something; for the rest it's just "Done".
const CHANGES_ROWS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY', 'TRUNCATE']);

// One chip per statement of a multi-statement run. Statements that returned
// rows open their result; the rest say what they did.
export function StatementStrip({ parts, shown, accent, onPick }) {
  const stripRef = useRef(null);
  // Which edges have chips scrolled out of sight, for the fade.
  const [cut, setCut] = useState({ l: false, r: false });
  const measure = () => {
    const el = stripRef.current;
    if (el) setCut({ l: el.scrollLeft > 1, r: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
  };
  useEffect(() => {
    stripRef.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    measure();
  }, [shown, parts.length]);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return undefined;
    // The scrollbar is hidden, so an ordinary mouse wheel scrolls sideways here.
    const wheel = (e) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', wheel, { passive: false });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { el.removeEventListener('wheel', wheel); ro.disconnect(); };
  }, []);
  const fade = cut.l || cut.r
    ? `linear-gradient(90deg, ${cut.l ? 'transparent, #000 28px' : '#000'}, ${cut.r ? '#000 calc(100% - 28px), transparent' : '#000'})`
    : undefined;
  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label="Statements in this run"
      onScroll={measure}
      style={fade ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
      className="flex-shrink-0 flex items-end gap-1 px-2 pt-1.5 overflow-x-auto ds-noscroll border-b border-[#efedea]"
    >
      {parts.map(p => {
        const on = p.job_id && p.job_id === shown;
        const opens = Boolean(p.job_id);
        const kind = p.statement_type || (p.text.match(/^\s*([A-Za-z]+)/)?.[1] || '').toUpperCase() || 'Statement';
        const what = p.status === 'failed' ? 'Failed'
          : p.status === 'skipped' ? 'Not run'
          : opens ? plural(p.row_count ?? 0, 'row')
          : CHANGES_ROWS.has(kind) && p.rows_affected != null ? `${fmtN(p.rows_affected)} affected` : 'Done';
        return (
          <button
            key={p.index}
            type="button"
            role="tab"
            aria-selected={Boolean(on)}
            disabled={!opens}
            onClick={() => onPick(p)}
            title={`${p.text}${p.status === 'failed' ? '\n\nThis statement failed. Open it to see the error' : p.status === 'skipped' ? '\n\nNot run, an earlier statement failed' : opens ? '' : '\n\nNo rows to show'}`}
            className={`relative top-px flex-shrink-0 flex items-center gap-1.5 h-[26px] pl-1.5 pr-2.5 rounded-t-[7px] border border-b-0 text-[12px] whitespace-nowrap transition-colors ${on
              ? 'bg-white border-[#e8e6e3] text-[#312c2a] font-medium'
              : opens ? 'border-transparent text-[#6e6259] hover:bg-[#f8f7f5] hover:text-[#312c2a]' : 'border-transparent text-[#a39992] cursor-default'}`}
          >
            <span
              className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10.5px] font-semibold tabular-nums"
              style={on ? { background: accent, color: '#fff' } : { background: '#f1efed', color: p.status === 'failed' ? '#9e0000' : '#6e6259' }}
            >
              {p.index}
            </span>
            <span>{kind}</span>
            <span className={`tabular-nums ${p.status === 'failed' ? 'text-[#9e0000]' : on ? 'text-[#6e6259]' : ''}`}>{what}</span>
          </button>
        );
      })}
    </div>
  );
}

export function RunBar({ dark, accent, busy, othersBusy, status, meta, elapsed, statementCount, leadHint, canRun, lockedReason, onRun, onRunAll, onCancel }) {
  const going = busy || othersBusy;
  const ms = going ? elapsed : meta?.elapsed_ms;
  const label = going ? (othersBusy ? 'Someone else is running this worksheet' : 'Running')
    : status === 'success' ? (meta?.statement_count > 1 ? `Done, ${meta.statement_count} statements` : 'Done')
    : status === 'failed' ? 'Failed'
    : status === 'cancelled' ? 'Cancelled'
    : statementCount > 1 ? `${statementCount} statements` : 'Ready';
  const dim = dark ? '#a39992' : '#766a63';
  const track = dark ? '#433b37' : '#efedea';
  // A quick query reads "28 ms", a slow one "4.2 s", a very slow one "2m 05s".
  const [num, unit] = ms == null ? ['0.0', 's'] : ms < 1000 && !going ? [String(Math.round(ms)), 'ms'] : ms < 60000 ? [(ms / 1000).toFixed(1), 's'] : [null, null];
  return (
    <div className="flex-shrink-0 flex items-center gap-1.5 min-w-0 px-2 py-1.5 border-t" style={{ borderColor: track }}>
      {busy ? (
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-2 rounded-[9px] bg-white text-[#312c2a] text-[13px] font-semibold shadow-[0_0_0_1px_#e8e6e3] hover:bg-[#f8f7f5] flex-shrink-0"
        >
          <Square size={12} fill="currentColor" />Cancel
          <span className="hidden md:inline-flex items-center h-[18px] px-1.5 rounded bg-[#f1efed] text-[10px] font-medium text-[#6e6259]">{MOD} Enter</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={onRun}
          disabled={!canRun}
          title={lockedReason || (statementCount > 1 ? `${MOD} + Enter runs the selection, or the statement at the cursor` : `${MOD} + Enter runs the selection, or the whole worksheet`)}
          className={`inline-flex items-center gap-1.5 h-7 pl-2.5 pr-2 rounded-[9px] text-[12.5px] font-semibold flex-shrink-0 transition-transform enabled:active:scale-[.97] disabled:cursor-not-allowed ${!canRun
            ? (dark ? 'bg-[#3a3330] text-[#8f847c]' : 'bg-[#f1efed] text-[#a39992]')
            : `text-white ${leadHint ? 'bg-[#9e0000] hover:bg-[#7f0000]' : 'bg-[#eb1700] hover:bg-[#c51300]'}`}`}
        >
          <Play size={13} fill="currentColor" />
          {leadHint ? `Run ${leadHint}` : statementCount > 1 ? 'Run statement' : 'Run'}
          <span className={`hidden md:inline-flex items-center h-[18px] px-1.5 rounded text-[10px] font-medium ${canRun ? 'bg-white/20' : dark ? 'bg-white/5' : 'bg-white'}`}>{MOD} Enter</span>
        </button>
      )}
      {!going && statementCount > 1 && (
        <button
          type="button"
          onClick={onRunAll}
          disabled={!canRun}
          title={`${MOD} + Shift + Enter runs every statement in order and shows the last result`}
          className={`inline-flex items-center gap-1.5 h-7 px-2 rounded-[9px] text-[12px] font-medium flex-shrink-0 disabled:opacity-45 ${dark ? 'text-[#d9d1ca] hover:bg-[#352f2c] hover:text-white' : 'text-[#4a423e] hover:bg-[#f1efed]'}`}
        >
          <ChevronsRight size={15} />Run all {statementCount}
        </button>
      )}
      <div className="flex-1 min-w-0 flex items-center gap-2.5 ml-1.5">
        {/* Only while something runs; once done, the words and the timer say it. */}
        {going && (
          <div className="relative flex-1 max-w-[340px] min-w-[40px] h-[5px] flex" aria-hidden="true">
            <span className="relative flex-1 rounded-full overflow-hidden" style={{ background: track }}>
              <span className="ds-run absolute inset-y-0 left-0 w-2/5 rounded-full" style={{ background: accent }} />
            </span>
          </div>
        )}
        <span className="min-w-0 truncate text-[12px]" style={{ color: status === 'failed' && !going ? (dark ? '#ff8a70' : '#9e0000') : dim }} aria-live="polite">{label}</span>
      </div>
      <div className={`flex-shrink-0 min-w-[56px] text-right font-johnson-display tabular-nums ${ms == null ? (dark ? 'text-[#6e6259]' : 'text-[#cbc4bc]') : dark ? 'text-white' : 'text-[#312c2a]'}`}>
        {num != null ? <><span className="text-[19px] font-medium">{num}</span><span className="ml-0.5 text-[11px]" style={{ color: dim }}>{unit}</span></> : <span className="text-[15px] font-medium">{fmtMs(ms)}</span>}
      </div>
    </div>
  );
}

// Top of the explorer: which engine, which account, and as whom.
export function ConnCard({ E, state, info, conn, connections, connId, onConn, role, roleOptions, roleKey, onRole, roleLabel, writesOk }) {
  // The user it signs in as. The server address and Snowflake account aren't much use here.
  const where = conn?.user || info?.user;
  const look = state === 'ready' ? ['#286d10', 'Connected', true] : state === 'checking' ? ['#a14a00', 'Connecting', false] : ['#9e0000', state === 'unconfigured' ? 'Not set up' : 'Offline', false];
  const chip = (k, v, warn) => (
    <span className={`inline-flex items-center gap-1.5 max-w-full h-[24px] px-2.5 rounded-full border text-[11.5px] ${warn ? 'bg-[#fff3ea] border-[#f6dfcc] text-[#a14a00]' : 'bg-white border-black/[.06] text-[#312c2a]'}`}>
      {k && <span className="text-[#766a63]">{k}</span>}<span className="truncate">{v}</span>
    </span>
  );
  return (
    <div className="flex-shrink-0 mx-3 mt-3 mb-1 px-3.5 py-3 rounded-[12px] transition-colors" style={{ background: E.soft }}>
      <div className="flex items-start gap-2.5">
        <img src={E.icon} alt="" className="w-[22px] h-[22px] mt-[2px] flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-johnson-display font-bold text-[16px] leading-tight text-[#312c2a]">{E.label}</div>
          <div className="truncate text-[11.5px] text-[#6e6259]" title={where || ''}>{where || (state === 'checking' ? 'Reaching the server...' : state === 'unconfigured' ? 'Not configured' : 'Server not reachable')}</div>
        </div>
        <span className="flex-shrink-0 inline-flex items-center gap-1.5 mt-[3px] text-[11px] font-medium" style={{ color: look[0] }}>
          <span className={`w-[7px] h-[7px] rounded-full ${look[2] ? 'ds-live' : ''}`} style={{ background: look[0] }} />{look[1]}
        </span>
      </div>
      {(!E.pickDb || (connections.length > 1 && onConn) || !writesOk) && (
      <div className="flex flex-wrap items-center gap-1.5 mt-2.5 min-w-0">
        {E.pickDb ? (
          connections.length > 1 && onConn ? (
            <Picker size="sm" variant="chip" prefix="Connection" value={connId || ''} onChange={e => onConn(e.target.value)} title="Connection this worksheet runs on" aria-label="Login" className="max-w-full">
              {connections.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Picker>
          ) : null
        ) : (
          roleOptions.length > 0 && onRole ? (
            <Picker size="sm" variant="chip" prefix="Role" value={roleKey} onChange={e => onRole(e.target.value)} title={role ? `Role: ${role}` : 'Role this worksheet runs as'} aria-label="Role" className="max-w-full">
              {roleOptions.map(o => <option key={`${o.conn}|${o.role}`} value={`${o.conn}|${o.role}`}>{roleLabel(o)}</option>)}
            </Picker>
          ) : chip('Role', role || 'default')
        )}
        {!E.pickDb && chip('Warehouse', conn?.warehouse || info?.warehouse || 'default')}
        {!writesOk && chip(null, 'Read only', true)}
      </div>
      )}
    </div>
  );
}

// A view in the results bar: one segment of a pill switcher.
export function ViewTab({ active, onClick, icon, children, title, accent, compact }) {
  const IconCmp = icon;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={typeof children === 'string' ? children : undefined}
      title={compact ? `${children}: ${title}` : title}
      onClick={onClick}
      className={`flex-shrink-0 inline-flex items-center gap-1.5 h-[24px] px-2 rounded-[7px] text-[12px] font-medium whitespace-nowrap transition-[color,background-color,box-shadow] ${
        active ? 'bg-white text-[#312c2a] shadow-[0_1px_2px_rgba(49,44,42,.12)]' : 'text-[#6e6259] hover:text-[#312c2a]'}`}
    >
      <IconCmp size={13} strokeWidth={2} style={active ? { color: accent } : undefined} />
      <span className={compact ? 'hidden' : ''}>{children}</span>
    </button>
  );
}

// Dropdown with a search box. Same props as a <select> with <option> children,
// and onChange gets { target: { value } } so call sites read like a select.
const PICKER_CSS = `
.sf-pick-list::-webkit-scrollbar { width: 8px; }
.sf-pick-list::-webkit-scrollbar-track { background: transparent; margin: 4px 0; }
.sf-pick-list::-webkit-scrollbar-thumb { background: #d5cfc9; border-radius: 8px; border: 2px solid #fff; }
.sf-pick-list::-webkit-scrollbar-thumb:hover { background: #a39992; }
@supports not selector(::-webkit-scrollbar) {
  .sf-pick-list { scrollbar-width: thin; scrollbar-color: #d5cfc9 transparent; }
}
`;

// Motion for the pane: results arriving, a run in progress, the live dot.
const DS_CSS = `
@keyframes ds-scan { 0% { transform: translateY(-100%); opacity: .9 } 85% { opacity: .5 } 100% { transform: translateY(var(--ds-h, 600px)); opacity: 0 } }
@keyframes ds-run { 0% { transform: translateX(-100%) } 100% { transform: translateX(250%) } }
@keyframes ds-pulse { 0% { transform: scale(1); opacity: .45 } 70%, 100% { transform: scale(3); opacity: 0 } }
@keyframes ds-in { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
@keyframes ds-count { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
.ds-scan { position: absolute; left: 0; right: 0; top: 0; height: 70px; pointer-events: none; z-index: 15; will-change: transform, opacity; animation: ds-scan 1s cubic-bezier(.2,.8,.2,1) forwards }
.ds-in { animation: ds-in .45s cubic-bezier(.2,.8,.2,1) both }
.ds-count { animation: ds-count .35s cubic-bezier(.2,.8,.2,1) both }
/* Transform and opacity only: a box-shadow pulse repaints every frame, which a cloud PC without a GPU feels. */
.ds-live { position: relative }
.ds-live::after { content: ''; position: absolute; inset: 0; border-radius: inherit; background: inherit; animation: ds-pulse 2.4s ease-out infinite; will-change: transform, opacity }
.ds-run { animation: ds-run 1.2s ease-in-out infinite }
.ds-noscroll { scrollbar-width: none } .ds-noscroll::-webkit-scrollbar { display: none }
/* Thin, warm scrollbars across Data Studio (popups included), darker on hover */
.ds-root, .ds-root *, .ds-pop, .ds-pop * { scrollbar-width: thin; scrollbar-color: #d5cfc9 transparent }
.ds-root *:hover, .ds-pop *:hover { scrollbar-color: #a39992 transparent }
.ds-root .ds-dark, .ds-root .ds-dark * { scrollbar-color: #4a423e transparent }
.ds-root .ds-dark:hover, .ds-root .ds-dark *:hover { scrollbar-color: #6e6259 transparent }
html.reduce-motion .ds-scan { display: none }
html.reduce-motion .ds-in, html.reduce-motion .ds-count, html.reduce-motion .ds-live::after, html.reduce-motion .ds-sfbar { animation: none }
html.reduce-motion .ds-run { animation: none; width: 100%; opacity: .55 }
`;

if (typeof document !== 'undefined' && !document.getElementById('ds-css')) {
  const el = document.createElement('style');
  el.id = 'ds-css';
  el.textContent = DS_CSS;
  document.head.appendChild(el);
}

if (typeof document !== 'undefined' && !document.getElementById('sf-pick-css')) {
  const el = document.createElement('style');
  el.id = 'sf-pick-css';
  el.textContent = PICKER_CSS;
  document.head.appendChild(el);
}

export function Picker({ icon: Icon, size = 'md', tone = 'light', variant, prefix, className = '', children, value, onChange, disabled, title, 'aria-label': label }) {
  const dark = tone === 'dark';
  const sm = size === 'sm';
  const eng = useEngine();     // the list opens outside the pane, so it brings the colours along
  // 'crumb': a flat name chip, like the database > schema path over the editor.
  const crumb = variant === 'crumb';
  // 'chip': a white pill with a label in front ("Role ..."), like the chips beside it.
  const pill = variant === 'chip';
  const options = React.Children.toArray(children)
    .filter(c => c?.type === 'option')
    .map(c => ({ value: String(c.props.value ?? ''), label: String(c.props.children ?? c.props.value ?? '') }));
  const current = options.find(o => o.value === String(value ?? ''));

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const listRef = useRef(null);

  // The empty-value placeholder is only there to label an unset select.
  const shown = options.filter(o => o.value !== '' && (!q || o.label.toLowerCase().includes(q.toLowerCase())));

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth;
    const maxW = Math.min(380, vw - 16);
    // Grow to fit the longest name, open leftwards when there's no room on the right,
    // and never run off either edge of the screen.
    const x = r.left + maxW <= vw - 8 ? { left: r.left } : r.right - maxW >= 8 ? { right: vw - r.right } : { left: 8 };
    const below = window.innerHeight - r.bottom;
    const y = below < 260 && r.top > below ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 };
    setPos({ ...x, ...y, minWidth: Math.min(Math.max(r.width, 220), maxW), maxWidth: maxW });
  }, []);

  const openList = () => {
    if (disabled) return;
    place();
    setQ('');
    setHi(Math.max(0, options.filter(o => o.value !== '').findIndex(o => o.value === current?.value)));
    setOpen(true);
  };
  const close = (focus = true) => { setOpen(false); if (focus) btnRef.current?.focus(); };
  const pick = (o) => { if (o.value !== current?.value) onChange?.({ target: { value: o.value } }); close(); };

  useEffect(() => {
    if (!open) return;
    const outside = (e) => { if (!popRef.current?.contains(e.target) && !btnRef.current?.contains(e.target)) close(false); };
    const away = (e) => { if (!popRef.current?.contains(e.target)) close(false); };
    document.addEventListener('mousedown', outside);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', away, true);
    return () => {
      document.removeEventListener('mousedown', outside);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', away, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.querySelector(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, hi]);

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[hi]) pick(shown[hi]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') close(false);
  };

  return (
    <span className={`group relative inline-flex items-center self-center ${crumb ? 'min-w-[48px]' : 'min-w-[56px] sm:min-w-[72px]'} flex-shrink ${className}`}>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        title={title}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : openList())}
        onKeyDown={e => { if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key) && !open) { e.preventDefault(); openList(); } }}
        className={pill
          ? `w-full min-w-0 flex items-center gap-1.5 h-[24px] pl-2.5 pr-1.5 rounded-full border bg-white text-left text-[11.5px] text-[#312c2a] cursor-pointer transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${open ? 'border-[var(--sig)] ring-2 ring-[var(--sig-ring)]' : 'border-black/[.06] hover:border-[#cbc4bc] focus-visible:border-[var(--sig)]'}`
          : crumb
          ? `w-full min-w-0 flex items-center h-[24px] px-2 rounded-[6px] text-left text-[12px] font-medium cursor-pointer transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${dark
            ? `${open ? 'bg-[#433b37] text-white' : 'bg-[#352f2c] text-[#d9d1ca] hover:bg-[#433b37] hover:text-white'} focus-visible:ring-1 focus-visible:ring-[#a39992]`
            : `${open ? 'bg-[#e8e6e3] text-[#312c2a]' : 'bg-[#f1efed] text-[#4a423e] hover:bg-[#e8e6e3] hover:text-[#312c2a]'} focus-visible:ring-2 focus-visible:ring-[var(--sig-ring)]`}`
          : `w-full min-w-0 flex items-center gap-1.5 text-left cursor-pointer rounded-md border font-medium transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${dark
          ? `bg-[#352f2c] text-[#efe9e4] ${open ? 'border-[#6e6259]' : 'border-transparent hover:bg-[#433b37] focus-visible:border-[#a39992]'}`
          : `bg-white text-[#312c2a] shadow-[0_1px_0_rgba(49,44,42,0.04)] ${open ? 'border-[var(--sig)] ring-2 ring-[var(--sig-ring)]' : 'border-[#d5cfc9] hover:border-[#a39992] hover:bg-[#fbfaf9] focus-visible:border-[var(--sig)] focus-visible:ring-2 focus-visible:ring-[var(--sig-ring)]'}`} ${
          sm ? 'h-[22px] px-1.5 text-[11.5px]' : 'h-[28px] px-2 text-[12.5px]'}`}
      >
        {prefix && <span className="flex-shrink-0 text-[#766a63]">{prefix}</span>}
        {Icon && !crumb && !pill && <Icon size={sm ? 12 : 13} className={`hidden sm:block flex-shrink-0 ${open ? 'text-[var(--sig-ink)]' : dark ? 'text-[#a39992]' : 'text-[#766a63]'}`} />}
        <span className={`flex-1 min-w-0 truncate ${current?.value ? '' : `${dark ? 'text-[#a39992]' : 'text-[#766a63]'} font-normal`}`}>{current?.label || label}</span>
        {!crumb && <ChevronDown size={pill ? 12 : sm ? 12 : 14} className={`flex-shrink-0 transition-transform ${open ? 'rotate-180 text-[var(--sig-ink)]' : dark ? 'text-[#a39992]' : 'text-[#766a63]'}`} />}
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          style={{ ...sigVars(eng), position: 'fixed', ...pos, width: 'max-content', zIndex: 1000 }}
          className="ds-pop flex flex-col rounded-lg border border-[#e8e6e3] bg-white shadow-[0_10px_28px_rgba(49,44,42,0.14),0_2px_6px_rgba(49,44,42,0.06)] overflow-hidden"
        >
          <div className="relative p-1.5 border-b border-[#efedea]">
            <Search size={13} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#a39992]" />
            <input
              autoFocus
              value={q}
              onChange={e => { setQ(e.target.value); setHi(0); }}
              onKeyDown={onKey}
              placeholder={`Search ${(label || '').toLowerCase()}s`}
              aria-label={`Search ${label || ''}`}
              className="w-full h-[28px] pl-7 pr-7 rounded-md border border-[#e8e6e3] bg-[#fbfaf9] text-[12.5px] text-[#312c2a] placeholder:text-[#a39992] focus:outline-none focus:border-[var(--sig)] focus:bg-white"
            />
            {q && (
              <button type="button" onClick={() => { setQ(''); setHi(0); }} aria-label="Clear search" className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center rounded text-[#766a63] hover:text-[#312c2a]">
                <X size={12} />
              </button>
            )}
          </div>
          <div ref={listRef} role="listbox" aria-label={label} className="sf-pick-list max-h-[280px] overflow-y-auto p-1">
            {shown.length === 0 && <div className="px-2.5 py-3 text-center text-[12px] text-[#766a63]">No matches</div>}
            {shown.map((o, i) => {
              const on = o.value === current?.value;
              return (
                <div
                  key={o.value}
                  data-i={i}
                  role="option"
                  aria-selected={on}
                  onMouseEnter={() => setHi(i)}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => pick(o)}
                  title={o.label}
                  className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md cursor-pointer text-[12.5px] ${
                    on ? 'text-[var(--sig-ink)] font-semibold' : 'text-[#312c2a]'} ${i === hi ? (on ? 'bg-[var(--sig-mid)]' : 'bg-[#f4f2f0]') : (on ? 'bg-[#fdf0ee]' : '')}`}
                >
                  <Check size={13} className={`flex-shrink-0 ${on ? '' : 'invisible'}`} />
                  <span className="min-w-0 truncate"><Highlight text={o.label} q={q} /></span>
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}

export const Kbd = ({ children }) => (
  <kbd className="inline-flex items-center h-[18px] px-1.5 rounded border border-[#d5cfc9] bg-white text-[10.5px] font-sans text-[#6e6259] shadow-[0_1px_0_#d5cfc9]">
    {children}
  </kbd>
);

export const Spinner = ({ size = 14, className = '' }) => (
  <Loader2 size={size} className={`animate-spin text-[var(--sig-ink)] ${className}`} aria-label="Loading" />
);

export const StatusDot = ({ color, pulse }) => (
  <span className="relative inline-flex w-2 h-2 flex-shrink-0">
    {pulse && <span className="absolute inset-0 rounded-full animate-ping opacity-60" style={{ background: color }} />}
    <span className="relative w-2 h-2 rounded-full" style={{ background: color }} />
  </span>
);

// Thin indeterminate bar, the same cue Snowflake shows above a running grid.
export const ProgressBar = () => (
  <div className="relative h-[2px] w-full overflow-hidden bg-[var(--sig-soft)]">
    <style>{'@keyframes sfbar{0%{transform:translateX(-100%)}60%,100%{transform:translateX(286%)}}'}</style>
    <div className="ds-sfbar absolute top-0 left-0 h-full w-[35%] bg-[var(--sig)]" style={{ animation: 'sfbar 1.3s ease-in-out infinite', willChange: 'transform' }} />
  </div>
);

export const Skel = ({ w = '100%', h = 10, className = '' }) => (
  <div className={`animate-pulse rounded bg-[#ece9e6] ${className}`} style={{ width: w, height: h }} />
);

export function GridSkeleton({ cols = 6, rows = 12 }) {
  return (
    <div className="min-w-full">
      <div className="flex border-b border-[#e8e6e3] bg-[#f8f7f5]">
        <div className="w-[52px] flex-shrink-0 h-[44px] border-r border-[#e8e6e3]" />
        {Array.from({ length: cols }).map((_, i) => (
          <div key={i} className="flex-1 min-w-[120px] h-[44px] px-3 flex flex-col justify-center gap-1.5 border-r border-[#e8e6e3]">
            <Skel w="60%" h={9} />
            <Skel w="35%" h={7} />
          </div>
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className={`flex border-b border-[#f1efed] ${r % 2 ? 'bg-[#fbfaf9]' : ''}`}>
          <div className="w-[52px] flex-shrink-0 h-[30px] border-r border-[#f1efed]" />
          {Array.from({ length: cols }).map((_, c) => (
            <div key={c} className="flex-1 min-w-[120px] h-[30px] px-3 flex items-center border-r border-[#f1efed]">
              <Skel w={`${35 + ((r * 7 + c * 13) % 55)}%`} h={8} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }) {
  const IconCmp = icon;
  return (
    <div className="min-h-full flex items-center justify-center px-6 py-8">
      <div className="max-w-[420px] text-center">
        {IconCmp && (
          <div className="mx-auto mb-3.5 w-11 h-11 rounded-xl bg-[#f1efed] flex items-center justify-center text-[#6e6259]">
            <IconCmp size={20} strokeWidth={1.7} />
          </div>
        )}
        <div className="font-johnson-display text-[15px] font-bold text-[#312c2a]">{title}</div>
        {children && <div className="mt-1.5 text-[12.5px] leading-relaxed text-[#6e6259]">{children}</div>}
        {action && <div className="mt-4 flex items-center justify-center gap-2">{action}</div>}
      </div>
    </div>
  );
}

/* ------------------------------ errors ---------------------------------- */

export function ErrorPanel({ error, onRetry, onJump, retryLabel = 'Try again' }) {
  const [copied, setCopied] = useState(false);
  if (!error) return null;
  const e = parseSfError(error);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(e.raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* no clipboard */ }
  };
  return (
    <div className="p-5">
      <div className="max-w-[820px] rounded-lg border border-[#f3d0cc] bg-white overflow-hidden shadow-[0_1px_3px_rgba(49,44,42,.06)]">
        <div className="flex items-start gap-3 px-4 py-3.5 bg-[#fdf3f1] border-b border-[#f3d0cc]">
          <TriangleAlert size={18} className="flex-shrink-0 mt-[1px] text-[#9e0000]" />
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-bold text-[#312c2a] break-words">{e.title}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[#6e6259]">
              {e.code && <span>Error <span className="font-mono text-[#312c2a]">{e.code}</span></span>}
              {e.state && <span>SQL state <span className="font-mono text-[#312c2a]">{e.state}</span></span>}
              {e.line != null && <span>Line {e.line}, position {e.col}</span>}
            </div>
          </div>
        </div>
        {e.detail && (
          <pre className="m-0 px-4 py-3 max-h-[220px] overflow-auto text-[12px] leading-relaxed font-mono text-[#4a423e] whitespace-pre-wrap break-words">
            {e.detail}
          </pre>
        )}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-[#f1efed] bg-[#fbfaf9]">
          {onRetry && <Button size="sm" variant="dark" icon={RotateCcw} onClick={onRetry}>{retryLabel}</Button>}
          {onJump && e.line != null && (
            <Button size="sm" onClick={() => onJump(e.line, e.col)}>Go to line {e.line}</Button>
          )}
          <Button size="sm" variant="ghost" icon={copied ? Check : Copy} onClick={copy}>{copied ? 'Copied' : 'Copy error'}</Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- toasts --------------------------------- */

export function Toasts({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  const tone = {
    success: { Icon: CircleCheck, color: T.green },
    error: { Icon: TriangleAlert, color: T.maroon },
    info: { Icon: Info, color: T.muted },
  };
  return (
    <div className="pointer-events-none absolute bottom-12 right-4 z-[60] flex flex-col items-end gap-2 max-w-[calc(100%-32px)]">
      {toasts.map(t => {
        const s = tone[t.tone] || tone.info;
        return (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto flex items-start gap-2.5 w-[340px] max-w-full pl-3.5 pr-2 py-2.5 rounded-lg bg-white border border-[#e8e6e3] shadow-[0_8px_24px_rgba(49,44,42,.14)] text-[12.5px] text-[#312c2a]"
          >
            <s.Icon size={16} className="flex-shrink-0 mt-[1px]" style={{ color: s.color }} />
            <div className="flex-1 min-w-0 break-words leading-snug">{t.message}</div>
            <button onClick={() => onDismiss(t.id)} className="p-0.5 rounded text-[#766a63] hover:bg-[#f1efed]" aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* -------------------------------- pager --------------------------------- */

export function Pager({ page, totalPages, loading, onGo }) {
  const [draft, setDraft] = useState(String(page));
  useEffect(() => { setDraft(String(page)); }, [page]);
  const commit = () => {
    const n = parseInt(draft, 10);
    if (!Number.isNaN(n)) onGo(n);
    else setDraft(String(page));
  };
  const last = totalPages || 1;
  return (
    <div className="flex items-center gap-1">
      <IconButton icon={ChevronsLeft} label="First page" size={26} iconSize={14} onClick={() => onGo(1)} disabled={page <= 1 || loading} />
      <IconButton icon={ChevronLeft} label="Previous page" size={26} iconSize={14} onClick={() => onGo(page - 1)} disabled={page <= 1 || loading} />
      <span className="flex items-center gap-1.5 px-1 text-[12px] text-[#6e6259] tabular-nums whitespace-nowrap">
        Page
        <input
          type="number"
          min="1"
          value={draft}
          disabled={loading}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); e.target.blur(); } }}
          aria-label="Go to page"
          className="w-[52px] h-[26px] rounded-md border border-[#d5cfc9] bg-white px-1.5 text-center text-[12px] text-[#312c2a] tabular-nums focus:outline-none focus:border-[var(--sig)] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        of {fmtN(last)}
      </span>
      <IconButton icon={ChevronRight} label="Next page" size={26} iconSize={14} onClick={() => onGo(page + 1)} disabled={page >= last || loading} />
      <IconButton icon={ChevronsRight} label="Last page" size={26} iconSize={14} onClick={() => onGo(last)} disabled={page >= last || loading} />
    </div>
  );
}

/* -------------------------------- modals -------------------------------- */

export function Modal({ open, onClose, width = 480, children, labelledBy }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[#312c2a]/45 px-4 py-6" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onMouseDown={e => e.stopPropagation()}
        className="w-full max-h-full flex flex-col bg-white rounded-xl shadow-[0_24px_60px_rgba(49,44,42,.28)] overflow-hidden font-johnson-text"
        style={{ maxWidth: width }}
      >
        {children}
      </div>
    </div>
  );
}

export function ConfirmDestructiveModal({ info, onCancel, onConfirm, confirming }) {
  return (
    <Modal open={!!info} onClose={onCancel} width={460} labelledBy="sf-confirm-title">
      {info && (
        <>
          <div className="flex items-start gap-3.5 px-5 pt-5">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-[var(--sig-soft)] flex items-center justify-center text-[#9e0000]">
              <TriangleAlert size={19} />
            </div>
            <div className="min-w-0">
              <h3 id="sf-confirm-title" className="font-johnson-display font-bold text-[16px] text-[#312c2a]">
                {info.count > 1 ? `Run these ${info.count} statements?` : `Run this ${info.statement_type} statement?`}
              </h3>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#6e6259]">{info.message}</p>
              {info.warning && (
                <p className="mt-2.5 text-[12.5px] leading-relaxed text-[#9e0000] bg-[#fdf3f1] border border-[#f3d0cc] rounded-md px-3 py-2">
                  {info.warning.split('\n').map((w, i) => <span key={i} className="block">{w}</span>)}
                </p>
              )}
            </div>
          </div>
          <div className="mt-5 px-5 py-3.5 flex items-center justify-end gap-2 bg-[#f8f7f5] border-t border-[#e8e6e3]">
            <Button onClick={onCancel}>Cancel</Button>
            <Button variant="danger" onClick={onConfirm} disabled={confirming}>
              {confirming ? 'Running...' : info.count > 1 ? 'Run all' : `Run ${info.statement_type}`}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

// Read-only SQL with the same colours as the editor. Used for DDL, history,
// saved queries, the details tab and the change preview.
export function SqlCode({ sql, className = '', theme = 'light', format = true }) {
  const palette = TOKEN_COLORS[theme] || TOKEN_COLORS.light;
  const tokens = useMemo(() => tokenizeSql(format ? formatSql(sql || '') : (sql || '')), [sql, format]);
  return (
    <code className={`font-mono ${className}`}>
      {tokens.map((tok, i) => (
        <span key={i} style={{ color: palette[tok.kind] || palette.plain, fontStyle: tok.kind === 'comment' ? 'italic' : undefined }}>{tok.text}</span>
      ))}
    </code>
  );
}

const SHOW_MAX = 2_000_000;

    // characters drawn in the viewer; Copy and Download get all of it

// Text viewer (DDL, a cell). For a cell the grid only had the start of,
// loadFull fetches the whole value: shown pretty-printed when it is JSON,
// and it can be copied or saved as a file.
export function TextModal({ title, subtitle, body, onClose, mono = true, sql = false, loadFull, fileName }) {
  const [copied, setCopied] = useState(false);
  const [full, setFull] = useState(null);       // { text, truncated, size } | { error }
  const [loading, setLoading] = useState(false);
  useEffect(() => { setFull(null); setLoading(false); }, [title, body]);
  const text = full?.text ?? body ?? '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* no clipboard */ }
  };
  const load = async () => {
    setLoading(true);
    try {
      const got = await loadFull();
      let t = got.value === null || got.value === undefined ? 'NULL' : typeof got.value === 'string' ? got.value : JSON.stringify(got.value);
      let json = false;
      if (t.length < 5_000_000 && /^\s*[[{]/.test(t)) {
        try { t = JSON.stringify(JSON.parse(t), null, 2); json = true; } catch { /* not JSON */ }
      }
      setFull({ text: t, json, truncated: got.truncated, size: got.size });
    } catch (err) {
      setFull({ error: err.message || 'Could not load the value' });
    } finally {
      setLoading(false);
    }
  };
  const save = () => {
    const blob = new Blob([text], { type: full?.json ? 'application/json' : 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(fileName || title || 'value').replace(/[^\w.-]+/g, '_')}.${full?.json ? 'json' : 'txt'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const shown = text.length > SHOW_MAX ? `${text.slice(0, SHOW_MAX)}\n\n… the first ${fmtN(SHOW_MAX)} characters are shown. Copy or Download for all of it.` : text;
  return (
    <Modal open={!!title} onClose={onClose} width={820} labelledBy="sf-text-title">
      <div className="flex items-center gap-2 px-5 py-3.5 border-b border-[#e8e6e3]">
        <div className="min-w-0 flex-1">
          <h3 id="sf-text-title" className="font-johnson-display font-bold text-[15px] text-[#312c2a] break-all">{title}</h3>
          {subtitle && <div className="text-[11.5px] text-[#6e6259] mt-0.5">{full?.text ? `${subtitle} · ${fmtN(full.text.length)} characters${full.json ? ' · JSON, formatted' : ''}` : subtitle}</div>}
        </div>
        {loadFull && !full?.text && (
          <Button size="sm" variant="primary" icon={loading ? undefined : Maximize2} disabled={loading} onClick={load}>
            {loading ? <><Spinner size={12} /> Loading…</> : 'Load full value'}
          </Button>
        )}
        {full?.text && <Button size="sm" icon={Download} onClick={save}>Download</Button>}
        <Button size="sm" icon={copied ? Check : Copy} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
        <IconButton icon={X} label="Close" onClick={onClose} />
      </div>
      {full?.error && <div className="mx-5 mt-3 flex items-start gap-2 rounded-md bg-[#fdf3f1] px-3 py-2 text-[12.5px] text-[#9e0000]"><TriangleAlert size={14} className="flex-shrink-0 mt-0.5" />{full.error}</div>}
      {full?.truncated && <div className="mx-5 mt-3 rounded-md bg-[#fff6e5] px-3 py-2 text-[12.5px] text-[#7a4a00]">This value is {fmtN(full.size)} characters; the first {fmtN(full.text.length)} are here. Download the query result for all of it.</div>}
      <pre className={`flex-1 min-h-[120px] overflow-auto m-0 px-5 py-4 text-[12.5px] leading-relaxed text-[#312c2a] whitespace-pre-wrap break-words bg-[#fbfaf9] ${mono ? 'font-mono' : 'font-johnson-text'}`}>
        {sql ? <SqlCode sql={shown} /> : shown}
      </pre>
    </Modal>
  );
}

export function SavePromptModal({ open, initialName, onCancel, onSave }) {
  const [name, setName] = useState(initialName || '');
  const [shared, setShared] = useState(false);
  useEffect(() => { if (open) { setName(initialName || ''); setShared(false); } }, [open, initialName]);
  return (
    <Modal open={open} onClose={onCancel} width={420} labelledBy="sf-save-title">
      <div className="px-5 pt-5">
        <h3 id="sf-save-title" className="font-johnson-display font-bold text-[16px] text-[#312c2a]">Save query</h3>
        <label className="block mt-3.5 text-[11.5px] font-medium text-[#6e6259]" htmlFor="sf-save-name">Name</label>
        <input
          id="sf-save-name"
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onSave(name.trim(), shared); }}
          placeholder="e.g. Daily order counts"
          className="mt-1 w-full h-9 rounded-md border border-[#d5cfc9] px-3 text-[13px] text-[#312c2a] focus:outline-none focus:border-[var(--sig)] focus:ring-2 focus:ring-[var(--sig-ring)]"
        />
        <label className="mt-3 flex items-center gap-2 text-[12.5px] text-[#4a423e] cursor-pointer select-none">
          <input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} className="accent-[var(--sig)]" />
          Share with everyone who can use Data Studio
        </label>
      </div>
      <div className="mt-5 px-5 py-3.5 flex items-center justify-end gap-2 bg-[#f8f7f5] border-t border-[#e8e6e3]">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={() => onSave(name.trim(), shared)} disabled={!name.trim()}>Save</Button>
      </div>
    </Modal>
  );
}

const initials = (name) => {
  const parts = (name || '?').split('@')[0].split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
};

// Open connections (one per browser tab) folded into people.
function groupPeople(others, meta, colorOf) {
  const people = [];
  others.forEach(p => {
    if (p.email === meta?.you) return;
    let person = people.find(x => x.email === p.email);
    if (!person) {
      const member = meta?.members.find(m => m.email === p.email);
      person = { email: p.email, name: p.name, color: colorOf(p.email), viewOnly: member ? !member.can_edit : false, at: null };
      people.push(person);
    }
    person.typing = person.typing || p.typing;
    person.running = person.running || p.state === 'running';
    if (p.sel && person.at === null) person.at = p.sel.h;
  });
  return people;
}

// Avatars of who is here and what they are doing. Listens to the session by
// itself, so cursors and typing dots don't re-render the pane around it.
export function PeerBar({ session, meta, colorOf, onFollow }) {
  const people = groupPeople(usePeers(session), meta, colorOf);
  const photoFor = useDirectoryPhotos(people);
  const live = session?.status === 'live';
  // A reconnect is usually over in a blink; only say so when it isn't.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (live) { setSlow(false); return undefined; }
    const t = setTimeout(() => setSlow(true), 700);
    return () => clearTimeout(t);
  }, [live]);
  return (
    <div className="flex items-center mr-2" aria-label="People in this worksheet">
      {people.map(p => (
        <button key={p.email} type="button" onClick={() => p.at !== null && onFollow(p.at)} className="-ml-1.5 first:ml-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sig-ring)]" title={`${p.name} · click to jump to their cursor`}>
          <PeerAvatar person={{ ...p, photo: photoFor(p) }} />
        </button>
      ))}
      <span
        className="ml-1.5 hidden sm:flex items-center gap-1.5 text-[11.5px] text-[#6e6259] whitespace-nowrap"
        title={live || !slow ? 'Edits are shared as you type' : 'Edits you make now are sent once the connection is back'}
      >
        <StatusDot color={live || !slow ? T.green : T.amber} pulse={!live && slow} />
        {!live && slow ? 'Reconnecting' : meta?.role === 'view' ? 'View only' : people.length ? 'Live' : 'Only you'}
      </span>
    </div>
  );
}

// The strip under the editor: shortcut hints, or what the others are doing
// right now when someone is typing or running a query.
export function PeerActivity({ session, meta, children }) {
  const doing = groupPeople(usePeers(session), meta, () => '').filter(p => p.running || p.typing)
    .map(p => `${firstName(p.name)} is ${p.running ? 'running a query' : 'typing'}`).join(' · ');
  if (!doing) return children;
  return (
    <div className="flex items-center gap-1.5 min-w-0 text-[11.5px] text-[#0f68b2]" aria-live="polite">
      <Spinner size={11} /><span className="truncate">{doing}</span>
    </div>
  );
}

function PeerAvatar({ person, size = 24 }) {
  const doing = person.running ? 'running a query' : person.typing ? 'typing' : person.online === false ? 'not here right now' : person.viewOnly ? 'viewing' : 'here';
  return (
    <span
      title={`${person.name} · ${doing}`}
      className="relative inline-flex flex-shrink-0 items-center justify-center rounded-full text-white text-[10px] font-bold ring-2 ring-[#f8f7f5] select-none"
      style={{ width: size, height: size, background: person.color, opacity: person.online === false ? 0.4 : 1, boxShadow: person.photo ? `0 0 0 2px ${person.color}` : undefined }}
    >
      {person.photo ? <img src={person.photo} alt="" className="w-full h-full rounded-full object-cover" /> : initials(person.name)}
      {(person.running || person.typing) && <span className="absolute -right-0.5 -bottom-0.5 w-2 h-2 rounded-full bg-[var(--sig)] ring-1 ring-white animate-pulse" />}
    </span>
  );
}

const ROLE_SELECT = 'h-8 rounded-md border border-[#d5cfc9] bg-white px-2 text-[12.5px] text-[#312c2a] focus:outline-none focus:border-[var(--sig)] disabled:opacity-50';

// Who is in a shared worksheet and what they may do. Before the worksheet is
// shared it is the one place that says what sharing means.
export function ShareModal({ open, onClose, tab, meta, session, engineLabel, colorOf, onShare, onInvite, onRemove, onStop, link }) {
  const peers = usePeers(open ? session : null);
  const here = new Set(peers.map(p => p.email));
  const [email, setEmail] = useState('');
  const [canEdit, setCanEdit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [hits, setHits] = useState([]);       // directory matches: { name, email, title }
  const [pick, setPick] = useState(0);
  const [searching, setSearching] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (open) { setEmail(''); setCanEdit(true); setError(null); setHits([]); setConfirmStop(false); setCopied(false); } }, [open, tab?.id]);

  // Search the company directory (Azure AD) as you type: name or email.
  // Anyone it can't find can still be invited by typing the full address.
  const msal = useMsal();
  const msalRef = useRef(msal);
  msalRef.current = msal;
  const taken = new Set([meta?.owner?.email, ...(meta?.members || []).map(m => m.email)].filter(Boolean));
  const takenKey = [...taken].join('|');
  useEffect(() => {
    const q = email.trim();
    if (!open || q.length < 2) { setHits([]); setSearching(false); return undefined; }
    let stale = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const found = await searchDirectory(await graphToken(msalRef.current.instance, msalRef.current.accounts), q, 8);
        if (!stale) { setHits(found.filter(p => !takenKey.split('|').includes(p.email.toLowerCase()))); setPick(0); }
      } catch {
        if (!stale) setHits([]);
      } finally {
        if (!stale) setSearching(false);
      }
    }, 180);
    return () => { stale = true; clearTimeout(timer); };
  }, [email, open, takenKey]);
  const photoFor = useDirectoryPhotos(open ? [meta?.owner, ...(meta?.members || []), ...hits].filter(Boolean) : []);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try { await fn(); return true; } catch (err) { setError(err.message || 'That did not work'); return false; } finally { setBusy(false); }
  };
  const invite = async (who) => {
    const to = (who?.email || email).trim().toLowerCase();
    if (!to) return;
    if (await run(() => onInvite(to, canEdit, who?.name || ''))) { setEmail(''); setHits([]); }
  };
  const onEmailKey = (e) => {
    if (e.key === 'ArrowDown' && hits.length) { e.preventDefault(); setPick(i => (i + 1) % hits.length); }
    else if (e.key === 'ArrowUp' && hits.length) { e.preventDefault(); setPick(i => (i - 1 + hits.length) % hits.length); }
    else if (e.key === 'Escape' && hits.length) { e.stopPropagation(); setHits([]); }
    else if ((e.key === 'Enter' || e.key === 'Tab') && hits.length) { e.preventDefault(); invite(hits[pick]); }
    else if (e.key === 'Enter' && email.trim()) invite();
  };

  const owner = meta?.role === 'owner';
  const members = meta?.members || [];
  const full = members.length >= 2;
  const person = (m, role) => (
    <div key={m.email} className="flex items-center gap-2.5 py-1.5">
      <PeerAvatar person={{ name: m.name || m.email, color: colorOf(m.email), photo: photoFor(m), online: m.email === meta.you || here.has(m.email) }} size={28} />
      <div className="flex-1 min-w-0">
        <div className="truncate text-[13px] text-[#312c2a]">{m.name || m.email}{m.email === meta.you && <span className="text-[#766a63]"> (you)</span>}</div>
        {m.name && <div className="truncate text-[11.5px] text-[#766a63]">{m.email}</div>}
      </div>
      {role === 'owner' && <span className="text-[12px] text-[#6e6259]">Owner</span>}
      {role !== 'owner' && owner && (
        <>
          <select
            value={m.can_edit ? 'edit' : 'view'}
            disabled={busy}
            onChange={e => run(() => onInvite(m.email, e.target.value === 'edit'))}
            aria-label={`Access for ${m.email}`}
            className={ROLE_SELECT}
          >
            <option value="edit">Can edit</option>
            <option value="view">View only</option>
          </select>
          <IconButton icon={X} label={`Remove ${m.email}`} disabled={busy} onClick={() => run(() => onRemove(m.email))} />
        </>
      )}
      {role !== 'owner' && !owner && <span className="text-[12px] text-[#6e6259]">{m.can_edit ? 'Can edit' : 'View only'}</span>}
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} width={480} labelledBy="sf-share-title">
      <div className="px-5 pt-5 pb-1 overflow-y-auto">
        <h3 id="sf-share-title" className="font-johnson-display font-bold text-[16px] text-[#312c2a] truncate">Share &ldquo;{tab?.name}&rdquo;</h3>

        {!tab?.shared && (
          <p className="mt-2.5 text-[13px] leading-relaxed text-[#4a423e]">
            Work in this worksheet with up to two other people at the same time. Everyone sees the SQL as it is typed,
            where the others&apos; cursors are, and the results of queries run here. You choose who can edit and who can only watch.
          </p>
        )}

        {tab?.shared && !meta && (
          <div className="mt-4 flex items-center gap-2 text-[13px] text-[#6e6259]"><Spinner /> Connecting to the worksheet...</div>
        )}

        {tab?.shared && meta && (
          <>
            <div className="mt-3">
              {person(meta.owner, 'owner')}
              {members.map(m => person(m, 'member'))}
            </div>

            {owner && !full && (
              <div className="mt-3 pt-3 border-t border-[#e8e6e3]">
                <label className="block text-[11.5px] font-medium text-[#6e6259]" htmlFor="sf-share-email">Invite people</label>
                <div className="relative mt-1 flex items-center gap-2">
                  <input
                    id="sf-share-email"
                    autoFocus
                    type="text"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    onKeyDown={onEmailKey}
                    placeholder="Search by name or email"
                    autoComplete="off"
                    role="combobox"
                    aria-expanded={hits.length > 0}
                    aria-controls="sf-share-hits"
                    aria-activedescendant={hits.length ? `sf-share-hit-${pick}` : undefined}
                    className="flex-1 min-w-0 h-8 rounded-md border border-[#d5cfc9] px-2.5 text-[13px] text-[#312c2a] focus:outline-none focus:border-[var(--sig)] focus:ring-2 focus:ring-[var(--sig-ring)]"
                  />
                  <select value={canEdit ? 'edit' : 'view'} onChange={e => setCanEdit(e.target.value === 'edit')} aria-label="Access" className={ROLE_SELECT}>
                    <option value="edit">Can edit</option>
                    <option value="view">View only</option>
                  </select>
                  <Button variant="primary" icon={UserPlus} onClick={() => invite()} disabled={busy || !email.trim()}>Invite</Button>
                  {searching && !hits.length && <span className="absolute right-[196px] top-1/2 -translate-y-1/2"><Spinner size={12} /></span>}
                </div>
                {hits.length > 0 && (
                  <div id="sf-share-hits" role="listbox" className="mt-1 max-h-[264px] overflow-y-auto py-1 bg-white border border-[#e8e6e3] rounded-lg shadow-[0_6px_18px_rgba(49,44,42,.10)]">
                    {hits.map((h, i) => (
                      <div
                        key={h.email}
                        id={`sf-share-hit-${i}`}
                        role="option"
                        aria-selected={i === pick}
                        onMouseDown={e => { e.preventDefault(); invite(h); }}
                        onMouseEnter={() => setPick(i)}
                        className={`flex items-center gap-2.5 mx-1 px-2 py-1.5 rounded-md cursor-pointer ${i === pick ? 'bg-[var(--sig-soft)]' : ''}`}
                      >
                        <PeerAvatar person={{ name: h.name || h.email, color: '#766a63', photo: photoFor(h) }} size={28} />
                        <span className="flex-1 min-w-0">
                          <span className="block truncate text-[13px] text-[#312c2a]">{h.name || h.email}</span>
                          <span className="block truncate text-[11.5px] text-[#766a63]">{h.email}{h.title ? ` · ${h.title}` : ''}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <p className="mt-1.5 text-[11.5px] text-[#766a63]">They need access to the {engineLabel} pane. Send them the link once they are added.</p>
              </div>
            )}
            {owner && full && <p className="mt-3 pt-3 border-t border-[#e8e6e3] text-[12px] text-[#6e6259]">This worksheet is full: three people. Remove someone to invite another.</p>}
            <p className="mt-3 text-[11.5px] leading-relaxed text-[#766a63]">
              Results of queries run here are shown to everyone in the worksheet, whatever their own {engineLabel} role.
            </p>
          </>
        )}

        {error && <div className="mt-3 flex items-start gap-2 rounded-md bg-[#fdf3f1] px-3 py-2 text-[12.5px] text-[#9e0000]"><TriangleAlert size={14} className="flex-shrink-0 mt-0.5" />{error}</div>}
      </div>

      <div className="mt-4 px-5 py-3.5 flex items-center gap-2 bg-[#f8f7f5] border-t border-[#e8e6e3]">
        {tab?.shared && meta && (
          <>
            <Button icon={copied ? Check : Link2} onClick={() => { navigator.clipboard?.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}>
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            {owner && (confirmStop
              ? <Button variant="danger" disabled={busy} onClick={async () => { if (await run(onStop)) onClose(); }}>Yes, stop sharing</Button>
              : <Button variant="ghost" onClick={() => setConfirmStop(true)} title="Everyone keeps a private copy of the text">Stop sharing</Button>)}
            {!owner && <Button variant="ghost" icon={LogOut} disabled={busy} onClick={async () => { if (await run(() => onRemove(meta.you))) onClose(); }}>Leave</Button>}
          </>
        )}
        <span className="flex-1" />
        {tab?.shared
          ? <Button variant="primary" onClick={onClose}>Done</Button>
          : (
            <>
              <Button onClick={onClose}>Cancel</Button>
              <Button variant="primary" icon={Users} disabled={busy} onClick={() => run(onShare)}>{busy ? 'Sharing...' : 'Share worksheet'}</Button>
            </>
          )}
      </div>
    </Modal>
  );
}

// Shows a bound statement with its values filled in so people can read what
// will run. Display only, the real call still binds parameters.
function inlineParams(sql, params) {
  if (!Array.isArray(params) || !params.length) return sql;
  let i = 0;
  let out = '';
  let quote = null;
  for (const ch of sql) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    if (ch === '?' && i < params.length) {
      const v = params[i];
      i += 1;
      out += v === null || v === undefined ? 'NULL' : `'${(cellText(v) || '').replace(/'/g, "''")}'`;
      continue;
    }
    out += ch;
  }
  return out;
}

const KIND_STYLE = {
  update: { label: 'Update', color: '#a14a00', bg: '#fff3ea' },
  insert: { label: 'Insert', color: '#328714', bg: '#eef6ea' },
  delete: { label: 'Delete', color: '#9e0000', bg: '#fdf3f1' },
};

const showVal = (v) => (v === null || v === undefined || v === ''
  ? <span className="inline-block px-1.5 rounded bg-[#f1efed] text-[10.5px] font-medium text-[#766a63]">NULL</span>
  : <span className="break-all">{cellText(v)}</span>);

function ChangeCard({ change, index, statement, showSql, keys }) {
  const st = KIND_STYLE[change.kind] || KIND_STYLE.update;
  const keyCols = (keys && keys.length ? keys : Object.keys(change.original || {})).filter(k => change.original && k in change.original);
  const keyPreview = keyCols.slice(0, 3).map(k => `${k} = ${cellText(change.original[k]) ?? 'NULL'}`).join(' · ');
  return (
    <div className="rounded-lg border border-[#e8e6e3] bg-white overflow-hidden">
      <div className="flex items-center gap-2.5 px-3.5 py-2 border-b border-[#f1efed] bg-[#fbfaf9]">
        <span className="text-[11px] font-bold uppercase tracking-[.06em] px-2 py-0.5 rounded" style={{ color: st.color, background: st.bg }}>{st.label}</span>
        <span className="text-[12px] text-[#766a63] tabular-nums">#{index + 1}</span>
        {change.kind !== 'insert' && keyPreview && (
          <span className="min-w-0 truncate text-[11.5px] font-mono text-[#6e6259]" title={keyCols.map(k => `${k} = ${cellText(change.original[k]) ?? 'NULL'}`).join('\n')}>
            {keyPreview}{keyCols.length > 3 ? ` +${keyCols.length - 3} more` : ''}
          </span>
        )}
      </div>
      {change.kind === 'update' && (
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left text-[10.5px] font-bold uppercase tracking-[.06em] text-[#766a63]">
              <th className="px-3.5 py-1.5 w-[32%] font-bold">Column</th>
              <th className="px-3.5 py-1.5 w-[34%] font-bold">Before</th>
              <th className="px-3.5 py-1.5 font-bold">After</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(change.values).map(([col, v]) => (
              <tr key={col} className="border-t border-[#f1efed] align-top">
                <td className="px-3.5 py-2 font-medium text-[#312c2a] break-all">{col}</td>
                <td className="px-3.5 py-2 text-[#766a63] line-through decoration-[#cbc4bc]">{showVal(change.original?.[col])}</td>
                <td className="px-3.5 py-2 text-[#312c2a] bg-[#fffaf5]">{showVal(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {change.kind === 'insert' && (
        <div className="px-3.5 py-2 grid grid-cols-[minmax(120px,32%)_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
          {Object.entries(change.values).map(([col, v]) => (
            <React.Fragment key={col}>
              <span className="font-medium text-[#312c2a] break-all">{col}</span>
              <span className="text-[#312c2a]">{showVal(v)}</span>
            </React.Fragment>
          ))}
        </div>
      )}
      {change.kind === 'delete' && (
        <div className="px-3.5 py-2 text-[12.5px] text-[#6e6259]">This row will be removed from the table.</div>
      )}
      {showSql && statement && (
        <pre className="m-0 px-3.5 py-2.5 border-t border-[#f1efed] bg-[#fbfaf9] text-[12px] leading-relaxed whitespace-pre-wrap break-words max-h-[260px] overflow-auto">
          <SqlCode sql={inlineParams(statement.sql, statement.params)} />
        </pre>
      )}
    </div>
  );
}

export function ApplyChangesModal({ preview, table, saving, onCancel, onApply }) {
  const [showKeys, setShowKeys] = useState(false);
  const [showSql, setShowSql] = useState(false);
  useEffect(() => { if (preview) { setShowKeys(false); setShowSql(false); } }, [preview]);
  const keys = preview?.key_columns || [];
  const noPk = preview && !preview.has_primary_key && keys.length > 4;
  const counts = (preview?.changes || []).reduce((m, c) => ({ ...m, [c.kind]: (m[c.kind] || 0) + 1 }), {});
  return (
    <Modal open={!!preview} onClose={onCancel} width={780} labelledBy="sf-apply-title">
      {preview && (
        <>
          <div className="flex-shrink-0 px-5 pt-4 pb-3.5 border-b border-[#e8e6e3]">
            <div className="text-[11.5px] text-[#766a63] font-mono truncate" title={table ? `${table.database}.${table.schema}` : ''}>
              {table ? `${table.database}.${table.schema}` : ''}
            </div>
            <h3 id="sf-apply-title" className="mt-0.5 font-johnson-display font-bold text-[16px] leading-snug text-[#312c2a] break-all">
              Review changes to {table?.table}
            </h3>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {Object.entries(counts).map(([k, n]) => {
                const st = KIND_STYLE[k] || KIND_STYLE.update;
                return (
                  <span key={k} className="inline-flex items-center h-6 px-2.5 rounded-full text-[12px] font-medium" style={{ color: st.color, background: st.bg }}>
                    {n} {st.label.toLowerCase()}{n === 1 ? '' : 's'}
                  </span>
                );
              })}
              <button
                type="button"
                onClick={() => setShowKeys(v => !v)}
                className="inline-flex items-center gap-1 h-6 px-2.5 rounded-full border border-[#e8e6e3] text-[12px] text-[#4a423e] hover:bg-[#f4f2f0]"
                aria-expanded={showKeys}
              >
                <KeyRound size={12} className="text-[#a14a00]" />
                Matched on {keys.length === 1 ? keys[0] : `${keys.length} columns`}
                <ChevronDown size={12} className={`transition-transform ${showKeys ? 'rotate-180' : ''}`} />
              </button>
            </div>
            {showKeys && (
              <div className="mt-2.5 max-h-[110px] overflow-y-auto flex flex-wrap gap-1 p-2 rounded-md bg-[#f8f7f5] border border-[#efedea]">
                {keys.map(k => <span key={k} className="px-1.5 py-0.5 rounded bg-white border border-[#e8e6e3] text-[11px] font-mono text-[#4a423e]">{k}</span>)}
              </div>
            )}
            {noPk && (
              <p className="mt-2.5 text-[12px] leading-relaxed text-[#a14a00]">
                This table has no primary key, so each row is found by comparing every column. That works, just slower on big tables.
              </p>
            )}
          </div>

          <div className="flex-1 min-h-0 overflow-auto px-5 py-4 space-y-3 bg-[#f8f7f5]">
            {preview.changes.map((c, i) => (
              <ChangeCard key={i} change={c} index={i} statement={preview.statements[i]} showSql={showSql} keys={keys} />
            ))}
          </div>

          <div className="flex-shrink-0 flex flex-wrap items-center gap-3 px-5 py-3.5 border-t border-[#e8e6e3] bg-white">
            <label className="flex items-center gap-2 text-[12.5px] text-[#4a423e] cursor-pointer select-none">
              <input type="checkbox" checked={showSql} onChange={e => setShowSql(e.target.checked)} className="accent-[var(--sig)]" />
              Show SQL
            </label>
            <span className="hidden md:inline text-[11.5px] text-[#766a63]">Runs in one transaction. If any row doesn't match exactly once, nothing is changed.</span>
            <div className="ml-auto flex items-center gap-2">
              <Button onClick={onCancel}>Cancel</Button>
              <Button variant="danger" onClick={onApply} disabled={saving}>{saving ? 'Applying...' : 'Apply changes'}</Button>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

export function Highlight({ text, q }) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-[var(--sig-mid)] text-inherit rounded-[2px] px-[1px]">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}
