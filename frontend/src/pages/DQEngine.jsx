import React, { Suspense, useState, useMemo, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { useSearchParams, Navigate } from 'react-router-dom';
import { useRBAC } from '../context/RBACContext';
import { lazyPage } from '../utils/lazyPage';
import LoadingSpinner from './components/LoadingSpinner';

// J&J Custom Icons
import alertTriangleIcon from "/icons/JJ_Icon_Alert_RGB.svg";
import databaseIcon from "/icons/JJ_Icon_Database_RGB.svg";
import checkIcon from "/icons/JJ_Icon_Check_RGB.svg";
import analysisIcon from "/icons/JJ_Icon_Analysis_RGB.svg";
import recordsIcon from "/icons/JJ_Icon_Records_Information_RGB.svg";
import shieldCheckIcon from "/icons/JJ_Icon_Safety.svg";
import chevronRightIcon from "/icons/JJ_Icon_Chevron_Right.svg";
import { apiFetch } from '../utils/apiClient';

// Each suite is its own download, fetched the first time it's needed (or ahead of
// time from the picker), so opening one suite doesn't pay for the other four.
const ITChecksView = lazyPage(() => import('./ITChecksView'));
const BusinessDefinedChecks = lazyPage(() => import('./BusinessDefinedChecks'));
const DataValidation = lazyPage(() => import('./DataValidation'));
const IndCtaDataQuality = lazyPage(() => import('./IndCtaDataQuality'));
const SafetyDQ = lazyPage(() => import('./SafetyDQ'));
const SUITE_PAGES = {
  IT_Checks: ITChecksView,
  Data_Validation: DataValidation,
  Business_defined_checks: BusinessDefinedChecks,
  IND_CTA_DQ: IndCtaDataQuality,
  Safety_DQ: SafetyDQ,
};
const preloadSuite = (check) => SUITE_PAGES[check]?.preload();

const SuiteLoading = () => (
  <div className="flex items-center justify-center h-full min-h-[50vh] bg-jj-gray-01">
    <LoadingSpinner />
  </div>
);

// ─── Icon Wrapper ─────────────────────────────────────────────────────────────
const Icon = ({ src, alt, className = "w-6 h-6", color }) => {
  const getColorFilter = (colorClass) => {
    if (!colorClass) return {};
    const c = color || colorClass;
    if (c.includes('jj-green-03') || c.includes('text-green'))
      return { filter: 'brightness(0) saturate(100%) invert(37%) sepia(87%) saturate(1158%) hue-rotate(71deg) brightness(91%) contrast(93%)' };
    if (c.includes('jj-maroon-05') || c.includes('text-red'))
      return { filter: 'brightness(0) saturate(100%) invert(13%) sepia(97%) saturate(6477%) hue-rotate(359deg) brightness(91%) contrast(99%)' };
    if (c.includes('jj-orange-03'))
      return { filter: 'brightness(0) saturate(100%) invert(48%) sepia(97%) saturate(2446%) hue-rotate(347deg) brightness(102%) contrast(105%)' };
    if (c.includes('jj-blue-03'))
      return { filter: 'brightness(0) saturate(100%) invert(37%) sepia(93%) saturate(1535%) hue-rotate(189deg) brightness(91%) contrast(101%)' };
    if (c.includes('jj-blue-05'))
      return { filter: 'brightness(0) saturate(100%) invert(20%) sepia(93%) saturate(1535%) hue-rotate(200deg) brightness(91%) contrast(101%)' };
    if (c.includes('jj-red'))
      return { filter: 'brightness(0) saturate(100%) invert(17%) sepia(100%) saturate(7426%) hue-rotate(3deg) brightness(92%) contrast(118%)' };
    if (c.includes('jj-gray-08'))
      return { filter: 'brightness(0) saturate(100%) invert(15%) sepia(7%) saturate(806%) hue-rotate(346deg) brightness(95%) contrast(89%)' };
    if (c.includes('jj-gray-06'))
      return { filter: 'brightness(0) saturate(100%) invert(50%) sepia(6%) saturate(656%) hue-rotate(346deg) brightness(92%) contrast(88%)' };
    if (c.includes('jj-gray-05'))
      return { filter: 'brightness(0) saturate(100%) invert(65%) sepia(6%) saturate(556%) hue-rotate(346deg) brightness(92%) contrast(88%)' };
    if (c.includes('jj-gray-04'))
      return { filter: 'brightness(0) saturate(100%) invert(82%) sepia(6%) saturate(356%) hue-rotate(346deg) brightness(92%) contrast(88%)' };
    if (c.includes('white') || c.includes('invert'))
      return { filter: 'brightness(0) invert(1)' };
    return {};
  };
  return (
    <img src={src} alt={alt} className={className} style={getColorFilter(className)} />
  );
};

// ─── Error Boundary ───────────────────────────────────────────────────────────
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error, info) { console.error('DQEngine Error:', error, info); }
  render() {
    if (this.state.hasError) return (
      <div className="min-h-screen flex items-center justify-center bg-jj-gray-01 p-6">
        <div className="bg-white rounded-xl shadow-xl p-8 max-w-lg w-full border-t-4 border-jj-red">
          <div className="flex items-start gap-4 mb-6">
            <div className="w-12 h-12 bg-red-50 rounded-lg flex items-center justify-center flex-shrink-0">
              <Icon src={alertTriangleIcon} alt="Error" className="w-7 h-7 text-jj-maroon-05" />
            </div>
            <div>
              <h2 className="font-johnson-display text-xl text-jj-gray-08 mb-1" style={{ lineHeight: '110%' }}>Something went wrong</h2>
              <p className="font-johnson-text text-sm text-jj-gray-06">An unexpected error occurred while loading the Data Quality Engine.</p>
            </div>
          </div>
          <button onClick={() => window.location.reload()}
            className="w-full py-3 rounded-lg font-johnson-text font-bold text-sm bg-jj-red text-white hover:bg-jj-maroon-05 transition-colors duration-200">
            Reload Page
          </button>
        </div>
      </div>
    );
    return this.props.children;
  }
}

// ─── URL param allowlists ─────────────────────────────────────────────────────
// Scales its content down (never up) so it always fits the box height.
// Nothing gets hidden or scrolled on short screens, it just gets smaller.
const FitToBox = ({ children, className = '', align = 'center' }) => {
  const outerRef = useRef(null);
  const innerRef = useRef(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    const fit = () => {
      const avail = outer.clientHeight;
      const need = inner.offsetHeight;
      setScale(avail > 0 && need > avail ? avail / need : 1);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(outer);
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  const centered = align === 'center';
  return (
    <div ref={outerRef} className={`relative min-h-0 overflow-hidden ${className}`}>
      <div
        ref={innerRef}
        style={{
          position: 'absolute', left: 0, right: 0,
          top: centered ? '50%' : 0,
          transform: `${centered ? 'translateY(-50%) ' : ''}scale(${scale})`,
          transformOrigin: centered ? 'center center' : 'top left',
        }}
      >
        {children}
      </div>
    </div>
  );
};

// Chrome/Edge page zoom. outerWidth ignores page zoom, innerWidth doesn't,
// so their ratio is the zoom level. Snapped so window borders don't count.
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const readZoom = () => {
  if (typeof window === 'undefined' || !window.innerWidth || !window.outerWidth) return 1;
  const raw = window.outerWidth / window.innerWidth;
  return ZOOM_STEPS.reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a), 1);
};
const useBrowserZoom = () => {
  const [zoom, setZoom] = useState(readZoom);
  useEffect(() => {
    const onResize = () => setZoom(readZoom());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return zoom;
};

// Polls the backend /health route so the welcome badge shows real status.
// 'checking' until the first answer, then 'online' | 'degraded' | 'offline'.
const HEALTH_POLL_MS = 60_000;
const useEngineHealth = () => {
  const [status, setStatus] = useState('checking');
  useEffect(() => {
    let alive = true;
    let timer;
    const check = async () => {
      try {
        const res = await apiFetch('/health');
        const body = res.ok ? await res.json().catch(() => ({})) : null;
        if (!alive) return;
        if (!body) setStatus('offline');
        else setStatus(body.database && body.database.ok === false ? 'degraded' : 'online');
      } catch {
        if (alive) setStatus('offline');
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'visible') timer = setTimeout(async () => { await check(); schedule(); }, HEALTH_POLL_MS);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') { check(); schedule(); } };
    check();
    schedule();
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  return status;
};

const ENGINE_STATUS = {
  checking: { label: 'Checking engine',  color: '#a39992', pulse: false },
  online:   { label: 'Engine online',    color: '#328714', pulse: true },
  degraded: { label: 'Database degraded', color: '#c97a00', pulse: true },
  offline:  { label: 'Engine offline',   color: '#eb1700', pulse: false },
};

const VALID_CHECKS = ['IT_Checks', 'Data_Validation', 'Business_defined_checks', 'IND_CTA_DQ', 'Safety_DQ'];

const NetworkCanvas = () => {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return undefined;
    const ctx = canvas.getContext('2d');

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = canvas.offsetWidth * dpr;
      canvas.height = canvas.offsetHeight * dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    };
    resize();
    const resizeObs = new ResizeObserver(resize);
    resizeObs.observe(wrap);

    const NODES = [
      { fx: .82, fy: .12, r: 7, hue: 'blue', pulse: 0,   ps: .007 },
      { fx: .94, fy: .38, r: 9, hue: 'red',  pulse: 1.6, ps: .005 },
      { fx: .70, fy: .62, r: 6, hue: 'blue', pulse: 3.1, ps: .008 },
      { fx: .58, fy: .22, r: 5, hue: 'red',  pulse: .9,  ps: .009 },
      { fx: .88, fy: .78, r: 7, hue: 'blue', pulse: 2.4, ps: .006 },
      { fx: .50, fy: .48, r: 5, hue: 'blue', pulse: 4.2, ps: .010 },
      { fx: .96, fy: .60, r: 6, hue: 'red',  pulse: 1.1, ps: .007 },
      { fx: .65, fy: .88, r: 5, hue: 'red',  pulse: 5.0, ps: .008 },
      { fx: .78, fy: .46, r: 6, hue: 'blue', pulse: 0.5, ps: .006 },
    ];
    const EDGES = [
      [0, 1], [1, 2], [0, 3], [3, 1], [2, 4], [1, 4],
      [3, 5], [5, 2], [1, 6], [4, 6], [1, 8], [8, 2],
      [8, 4], [0, 8], [5, 7], [2, 7], [6, 4],
    ];
    const PACKETS = EDGES.map(([a, b], i) => ({
      a, b, t: Math.random(), speed: .0025 + Math.random() * .003,
      hue: i % 3 === 0 ? 'red' : 'blue',
    }));

    const BLUE = (a) => `rgba(15,104,178,${a})`;
    const RED = (a) => `rgba(235,23,0,${a})`;
    const col = (hue, a) => (hue === 'blue' ? BLUE(a) : RED(a));

    let raf;
    const draw = () => {
      const W = canvas.offsetWidth, H = canvas.offsetHeight;
      ctx.clearRect(0, 0, W, H);

      // Edges
      EDGES.forEach(([ai, bi]) => {
        const na = NODES[ai], nb = NODES[bi];
        const ax = na.fx * W, ay = na.fy * H, bx = nb.fx * W, by = nb.fy * H;
        const grad = ctx.createLinearGradient(ax, ay, bx, by);
        grad.addColorStop(0, BLUE(.18));
        grad.addColorStop(.5, BLUE(.28));
        grad.addColorStop(1, BLUE(.18));
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      });

      // Packets travelling along edges
      PACKETS.forEach(p => {
        p.t = (p.t + p.speed) % 1;
        const na = NODES[p.a], nb = NODES[p.b];
        const x = na.fx * W + (nb.fx * W - na.fx * W) * p.t;
        const y = na.fy * H + (nb.fy * H - na.fy * H) * p.t;
        const tx = na.fx * W + (nb.fx * W - na.fx * W) * Math.max(0, p.t - .06);
        const ty = na.fy * H + (nb.fy * H - na.fy * H) * Math.max(0, p.t - .06);
        const grad = ctx.createLinearGradient(tx, ty, x, y);
        grad.addColorStop(0, col(p.hue, 0));
        grad.addColorStop(1, col(p.hue, .65));
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(x, y);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, 2.8, 0, Math.PI * 2);
        ctx.fillStyle = col(p.hue, .85);
        ctx.fill();
      });

      // Nodes with pulsing glow
      NODES.forEach(n => {
        n.pulse = (n.pulse + n.ps) % (Math.PI * 2);
        const x = n.fx * W, y = n.fy * H;
        const sin = (Math.sin(n.pulse) + 1) / 2;

        const pR = n.r + 8 + sin * 22;
        ctx.beginPath();
        ctx.arc(x, y, pR, 0, Math.PI * 2);
        ctx.strokeStyle = col(n.hue, .08 + sin * .18);
        ctx.lineWidth = 1.2;
        ctx.stroke();

        const mR = n.r + 3 + sin * 10;
        ctx.beginPath();
        ctx.arc(x, y, mR, 0, Math.PI * 2);
        ctx.strokeStyle = col(n.hue, .18 + sin * .22);
        ctx.lineWidth = 1.2;
        ctx.stroke();

        ctx.shadowColor = n.hue === 'blue' ? 'rgba(15,104,178,.5)' : 'rgba(235,23,0,.5)';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(x, y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = col(n.hue, .22 + sin * .18);
        ctx.fill();
        ctx.strokeStyle = col(n.hue, .55 + sin * .3);
        ctx.lineWidth = 1.8;
        ctx.stroke();
        ctx.shadowBlur = 0;

        ctx.beginPath();
        ctx.arc(x, y, n.r * .4, 0, Math.PI * 2);
        ctx.fillStyle = col(n.hue, .7 + sin * .3);
        ctx.fill();
      });

      raf = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(raf);
      resizeObs.disconnect();
    };
  }, []);

  return (
    <div ref={wrapRef} className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 1 }}>
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block" />
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════════════════════
function DataQualityEngine() {
  const { hasPermission } = useRBAC();
  const zoom = useBrowserZoom();
  const engineStatus = ENGINE_STATUS[useEngineHealth()];
  const [searchParams, setSearchParams] = useSearchParams();
  // The URL is the only record of which suite is open. Back, Forward, Switch check,
  // a refresh or a pasted link all land on the same screen because nothing else decides it.
  const rawCheck = searchParams.get('check') ?? '';
  const activeCheck = VALID_CHECKS.includes(rawCheck) ? rawCheck : '';
  const runsKey = searchParams.getAll('run').join('|');
  const [reportData, setReportData] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [availableRuns, setAvailableRuns] = useState([]);
  const [runsMerged,    setRunsMerged]    = useState(null);
  const [newestDate, setNewestDate]   = useState(null);
  const [oldestDate, setOldestDate]   = useState(null);
  const [runsLoading, setRunsLoading] = useState(false);
  const [oracleConnections, setOracleConnections] = useState({ configured: [], has_default: true });

  // Stops async callbacks writing state after the page is gone.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // ── Derive which check types this user can access ──
  const availableCheckTypes = useMemo(() => [
    hasPermission('viewITChecks')       && 'IT_Checks',
    hasPermission('viewDataValidation') && 'Data_Validation',
    hasPermission('viewBusinessChecks') && 'Business_defined_checks',
    hasPermission('viewIndCtaQuality')     && 'IND_CTA_DQ',
    hasPermission('viewSafetyDQ')          && 'Safety_DQ',
  ].filter(Boolean), [hasPermission]);
  const canViewIT = availableCheckTypes.includes('IT_Checks');
  // Effects key on this string, not the array, so they only re-run when access really changes.
  const suitesKey = availableCheckTypes.join(',');

  // ── Which Oracle connections are configured (decides the re-validate buttons) ──
  // Only IT Checks needs it, so it's fetched once, the first time IT Checks opens.
  const oracleFetched = useRef(false);
  useEffect(() => {
    if (activeCheck !== 'IT_Checks' || oracleFetched.current || !canViewIT) return undefined;
    oracleFetched.current = true;
    let alive = true, settled = false;
    apiFetch(`/dq/oracle_connections`)
      .then(r => (r.ok ? r.json() : null))
      .then(data => { settled = !!data; if (alive && data) setOracleConnections(data); })
      .catch(() => {})
      .finally(() => { if (!settled) oracleFetched.current = false; }); // failed: try again next time
    // Left before it answered: fetch again next time instead of keeping nothing.
    return () => { alive = false; if (!settled) oracleFetched.current = false; };
  }, [activeCheck, canViewIT]);

  // On the picker, download the suites in the background so opening one is instant.
  useEffect(() => {
    if (activeCheck) return undefined;
    const run = () => suitesKey.split(',').forEach(preloadSuite);
    if (window.requestIdleCallback) {
      const id = window.requestIdleCallback(run, { timeout: 2000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(run, 300);
    return () => clearTimeout(id);
  }, [activeCheck, suitesKey]);

  // Only the newest load may write state. Bumping this also cancels a load
  // that is still running when the user leaves IT Checks.
  const loadSeq = useRef(0);
  // Which runs the IT Checks data on screen (or in flight) belongs to; null = nothing loaded.
  const loadedKeyRef = useRef(null);
  const availableRunsRef = useRef(availableRuns);
  availableRunsRef.current = availableRuns;

  // A table can be refreshed only if its source Oracle connection is configured.
  const canRefreshTable = useCallback((table) => {
    if (!hasPermission('runITChecks')) return 'hidden';
    // Re-validate only speaks Oracle; MariaDB sources (HAQ) would hit the Oracle default and fail.
    if (/^haq/i.test(table.source_db || '')) return 'no-connection';
    // same for SQL Server (LIFT): validate those again from Pipeline Studio
    if ((table._source_type || table.source_type) === 'SQL Server' || /lift/i.test(table.source_db || '')) return 'no-connection';
    if (oracleConnections.configured.length === 0 && !oracleConnections.has_default) return 'no-connection';
    if (oracleConnections.has_default) return 'active';
    const key = (table.source_db || table.target_database || '').toUpperCase();
    const connected = !!key && oracleConnections.configured.some(k => key.includes(k.toUpperCase()));
    return connected ? 'active' : 'no-connection';
  }, [hasPermission, oracleConnections]);

  // Opening a suite or going back to the picker is just a URL change (a new history entry).
  const openCheckType = useCallback((t) => setSearchParams({ check: t }), [setSearchParams]);
  const resetState = useCallback(() => setSearchParams({}), [setSearchParams]);

  // Loads IT Checks results. loadDates: null = all runs, string[] = those runs.
  const loadReport = useCallback(async (loadDates = null, refreshRuns = false) => {
    const dates = Array.isArray(loadDates) ? loadDates : loadDates ? [loadDates] : [];
    loadedKeyRef.current = dates.join('|');
    const seq = ++loadSeq.current;
    const stale = () => seq !== loadSeq.current || !isMountedRef.current;
    setIsLoading(true); setLoadError('');
    // The run list and the report don't depend on each other, so fetch both at once.
    // The run list is best-effort: if it fails the report still shows.
    if (!dates.length || refreshRuns || !availableRunsRef.current.length) {
      setRunsLoading(true);
      apiFetch(`/dq/validation_report_dates`)
        .then(r => (r.ok ? r.json() : null))
        .then(d => { if (d && !stale()) setAvailableRuns(d.runs || []); })
        .catch(err => { if (!stale()) console.error(err); })
        .finally(() => { if (!stale()) setRunsLoading(false); });
    }
    try {
      let url = `/dq/validation_report`;
      if (dates.length === 1) url += `?load_date=${encodeURIComponent(dates[0])}`;
      else if (dates.length > 1) url += `?load_dates=${encodeURIComponent(dates.join(','))}`;

      const res = await apiFetch(url);
      // 404 = no runs saved yet (fresh install / all runs trimmed): show the empty page, not an error
      const data = res.status === 404 && !dates.length ? { report_data: { pipeline_results: [] }, runs_merged: 0 } : null;
      if (!data && !res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || res.statusText || `HTTP ${res.status}`);
      }
      const payload = data || await res.json();
      if (stale()) return;
      if (!payload.report_data) throw new Error('Invalid data format from server');

      setReportData(payload.report_data);
      setRunsMerged(payload.runs_merged ?? 1);
      setNewestDate(payload.newest_date || null);
      setOldestDate(payload.oldest_date || null);
    } catch (err) {
      if (stale()) return;
      console.error(err);
      setLoadError(`Failed to load data: ${err.message}`);
    } finally { if (!stale()) setIsLoading(false); }
  }, []);

  // ── Keep IT Checks data in step with the URL ──
  // Entering IT Checks (click, Forward, refresh, link) loads it; leaving it
  // cancels any load in flight and drops the data so a late response can't
  // pull the page back. ITChecksView loads run changes itself while it is open;
  // loadedKeyRef stops this effect loading the same runs a second time.
  useEffect(() => {
    if (activeCheck === 'IT_Checks' && canViewIT) {
      if (loadedKeyRef.current !== runsKey) loadReport(runsKey ? runsKey.split('|') : null);
      return;
    }
    if (loadedKeyRef.current === null) return;
    loadSeq.current++;
    loadedKeyRef.current = null;
    setReportData(null);
    setAvailableRuns([]);
    setRunsMerged(null);
    setNewestDate(null);
    setOldestDate(null);
    setIsLoading(false);
    setRunsLoading(false);
    setLoadError('');
  }, [activeCheck, runsKey, canViewIT, loadReport]);

  // Re-validate one table and patch it into reportData. Returns the new
  // validation_result; throws on failure so the caller can report it.
  const handleRevalidateTable = useCallback(async (table) => {
    const res = await apiFetch(`/dq/validate_single_table`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipeline_name:   table.pipeline_name,
        table_name:      table.table_name,
        source_schema:   table.source_schema,
        target_database: table.target_database,
        target_schema:   table.target_schema,
        snowflake_table: table.snowflake_table,
        source_db:       table.source_db || '',
      })
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || 'Validation failed'); }
    const data = await res.json();
    if (!data.success || !data.validation_result) throw new Error(data.message || data.detail || 'Validation failed');
    if (isMountedRef.current) {
      setReportData(prev => {
        if (!prev?.pipeline_results) return prev;
        return {
          ...prev,
          pipeline_results: prev.pipeline_results.map(pipeline => {
            if (pipeline.pipeline_name !== table.pipeline_name || !pipeline.validation_results?.table_validations) return pipeline;
            return {
              ...pipeline,
              validation_results: {
                ...pipeline.validation_results,
                // Replace, don't merge: an old row_counts / error must not survive a fresh result.
                // Keep only the merge annotations (_source_db, _source_schema, …).
                table_validations: pipeline.validation_results.table_validations.map(t =>
                  t.table_name === table.table_name
                    && (t._source_db || '') === (table.source_db || '')
                    && (t._source_schema || pipeline.source_schema || 'Unknown') === table.source_schema
                    ? { ...Object.fromEntries(Object.entries(t).filter(([k]) => k.startsWith('_'))), ...data.validation_result }
                    : t
                )
              }
            };
          })
        };
      });
    }
    return data.validation_result;
  }, []);

  // ──────────────────────────────────────────────────────────────────────────
  // WELCOME SCREEN
  // ──────────────────────────────────────────────────────────────────────────
  if (!activeCheck) {
    // Only one suite: skip the picker. Replace, so Back doesn't land here and bounce.
    if (availableCheckTypes.length === 1) {
      return <Navigate to={{ search: `?check=${availableCheckTypes[0]}` }} replace />;
    }

    const checkTypeOptions = [
      {
        value: 'IT_Checks', icon: databaseIcon, label: 'IT Checks',
        desc: 'Row counts, schema validation, constraint reconciliation etc.',
      },
      {
        value: 'Data_Validation', icon: checkIcon, label: 'Data Validation',
        desc: 'Guided source-to-target validation with a redesigned setup flow.',
        beta: true,
      },
      {
        value: 'Business_defined_checks', icon: analysisIcon, label: 'Business Defined Checks',
        desc: 'Custom logic and data-quality rules tailored to your domain.',
      },
      {
        value: 'IND_CTA_DQ', icon: recordsIcon, label: 'IND/CTA Data Quality',
        desc: 'Live IND/CTA issue tracker: open vs fixed, rule hotspots, name match scores.',
      },
      {
        value: 'Safety_DQ', icon: shieldCheckIcon, label: 'Safety',
        desc: 'Safety data quality dashboard: pass rates by dimension, domain and rule.',
      },
    ]
      .filter(item => availableCheckTypes.includes(item.value))
      // number after filtering so a user with three suites sees 01-03, not 01, 03, 05
      .map((item, i) => ({ ...item, num: String(i + 1).padStart(2, '0') }));

    return (
      <div
        className="overflow-hidden flex bg-jj-gray-01"
        // Zoomed in: lay out as if at 100% (zoom x the visible height) so the
        // page grows and <main> scrolls, instead of shrinking to undo the zoom.
        style={{ height: zoom > 1 ? `${zoom * 100}%` : '100%', fontFamily: "'JohnsonText', Arial, sans-serif" }}
      >

        {/* ═══ LEFT PANEL ═══ */}
        <div className="hidden lg:flex relative overflow-hidden flex-col" style={{ flex: '0 0 58%' }}>
          {/* BG: warm base + dot grid */}
          <div className="absolute inset-0" style={{ background: '#f7f5f2' }} />
          <div className="absolute inset-0" style={{ backgroundImage: 'radial-gradient(circle, rgba(175,165,155,.45) 1px, transparent 1px)', backgroundSize: '26px 26px' }} />

          {/* BG: concentric data rings */}
          <div className="absolute" style={{
            right: -180, top: '50%', transform: 'translateY(-50%)', width: 760, height: 760, borderRadius: '50%',
            border: '1px solid rgba(15,104,178,.13)',
            boxShadow: '0 0 0 70px rgba(15,104,178,.05), 0 0 0 140px rgba(15,104,178,.04), 0 0 0 210px rgba(15,104,178,.03), 0 0 0 290px rgba(235,23,0,.025), 0 0 0 380px rgba(235,23,0,.015)',
            animation: 'dqe-ring 6s ease-in-out infinite',
          }} />
          <div className="absolute" style={{
            right: -180, top: '50%', transform: 'translateY(-50%)', width: 340, height: 340, borderRadius: '50%',
            border: '1.5px solid rgba(235,23,0,.12)', animation: 'dqe-ring 5s ease-in-out 1s infinite',
          }} />

          {/* BG: horizontal data streams */}
          <div className="absolute left-0 right-0" style={{ top: '28%', height: 1, overflow: 'hidden', opacity: .35 }}>
            <div style={{ height: 1, background: 'linear-gradient(90deg,transparent 0%,rgba(15,104,178,.6) 30%,rgba(15,104,178,.6) 70%,transparent 100%)', animation: 'dqe-stream 7s linear 0s infinite' }} />
          </div>
          <div className="absolute left-0 right-0" style={{ top: '44%', height: 1, overflow: 'hidden', opacity: .22 }}>
            <div style={{ height: 1, background: 'linear-gradient(90deg,transparent 0%,rgba(235,23,0,.5) 35%,rgba(235,23,0,.5) 65%,transparent 100%)', animation: 'dqe-stream 9s linear 2.5s infinite' }} />
          </div>
          <div className="absolute left-0 right-0" style={{ top: '66%', height: 1, overflow: 'hidden', opacity: .28 }}>
            <div style={{ height: 1, background: 'linear-gradient(90deg,transparent 0%,rgba(15,104,178,.5) 30%,rgba(15,104,178,.5) 70%,transparent 100%)', animation: 'dqe-stream 8s linear 1.2s infinite' }} />
          </div>

          {/* BG: radar sweep + dashed orbits */}
          <div className="absolute" style={{
            right: -180, top: '50%', width: 760, height: 760, borderRadius: '50%',
            background: 'conic-gradient(from 0deg,rgba(15,104,178,.07) 0deg,rgba(15,104,178,.03) 40deg,transparent 80deg,transparent 360deg)',
            animation: 'dqe-radar 12s linear infinite', transformOrigin: 'center center', transform: 'translateY(-50%)',
          }} />
          <div className="absolute" style={{ right: -180, top: '50%', width: 920, height: 920, borderRadius: '50%', border: '1.5px dashed rgba(15,104,178,.1)', animation: 'dqe-orbit 28s linear infinite' }} />
          <div className="absolute" style={{ right: -180, top: '50%', width: 480, height: 480, borderRadius: '50%', border: '1px dashed rgba(235,23,0,.1)', animation: 'dqe-radar 18s linear infinite' }} />

          {/* BG: scanline sweeps */}
          <div className="absolute left-0 right-0" style={{ height: '1.5px', background: 'linear-gradient(90deg,transparent 0%,rgba(15,104,178,.18) 25%,rgba(15,104,178,.3) 50%,rgba(15,104,178,.18) 75%,transparent 100%)', animation: 'dqe-scan 9s linear 0s infinite' }} />
          <div className="absolute left-0 right-0" style={{ height: 1, background: 'linear-gradient(90deg,transparent 0%,rgba(235,23,0,.15) 30%,rgba(235,23,0,.25) 50%,rgba(235,23,0,.15) 70%,transparent 100%)', animation: 'dqe-scan 9s linear 4.5s infinite' }} />

          {/* BG: vertical data streams */}
          <div className="absolute top-0 bottom-0" style={{ left: '62%', width: 1, overflow: 'hidden', opacity: .3 }}>
            <div style={{ width: 1, height: '100%', background: 'linear-gradient(180deg,transparent 0%,rgba(15,104,178,.55) 30%,rgba(15,104,178,.55) 70%,transparent 100%)', animation: 'dqe-vstream 6s linear 1s infinite' }} />
          </div>
          <div className="absolute top-0 bottom-0" style={{ left: '40%', width: 1, overflow: 'hidden', opacity: .18 }}>
            <div style={{ width: 1, height: '100%', background: 'linear-gradient(180deg,transparent 0%,rgba(235,23,0,.5) 35%,rgba(235,23,0,.5) 65%,transparent 100%)', animation: 'dqe-vstream 8s linear 3s infinite' }} />
          </div>

          {/* BG: floating data particles */}
          {[
            { right: '22%', top: '20%', size: 5, color: 'rgba(15,104,178,.4)',  dur: '5s',   delay: '0s' },
            { right: '38%', top: '35%', size: 4, color: 'rgba(235,23,0,.35)',  dur: '6.5s', delay: '.8s' },
            { right: '15%', top: '58%', size: 6, color: 'rgba(15,104,178,.3)', dur: '7s',   delay: '.4s' },
            { right: '45%', top: '72%', size: 3, color: 'rgba(235,23,0,.32)',  dur: '5.5s', delay: '1.6s' },
            { right: '28%', top: '12%', size: 4, color: 'rgba(15,104,178,.28)', dur: '8s',  delay: '2.2s' },
            { right: '52%', top: '52%', size: 5, color: 'rgba(235,23,0,.22)',  dur: '6s',   delay: '3s' },
            { right: '10%', top: '82%', size: 4, color: 'rgba(15,104,178,.25)', dur: '7.5s', delay: '1s' },
            { right: '33%', top: '88%', size: 3, color: 'rgba(235,23,0,.2)',   dur: '5.8s', delay: '4s' },
          ].map((p, i) => (
            <div key={i} className="absolute rounded-full" style={{ right: p.right, top: p.top, width: p.size, height: p.size, background: p.color, animation: `dqe-float ${p.dur} ease-in-out ${p.delay} infinite` }} />
          ))}

          {/* Animated canvas network graph, layered above the decorative backdrop */}
          <NetworkCanvas />

          {/* BG: fades for text legibility */}
          <div className="absolute inset-0" style={{ background: 'linear-gradient(100deg,rgba(247,245,242,.96) 0%,rgba(247,245,242,.88) 36%,rgba(247,245,242,.5) 58%,rgba(247,245,242,0) 100%)' }} />
          <div className="absolute bottom-0 left-0 right-0" style={{ height: 160, background: 'linear-gradient(to top,rgba(247,245,242,.92) 0%,transparent 100%)' }} />

          {/* ── Content layer ── */}
          <div className="relative flex flex-col h-full" style={{ zIndex: 2, padding: 'clamp(18px,4vh,36px) 52px' }}>

            {/* Engine status */}
            <div className="flex items-center justify-between flex-wrap" style={{ gap: 16 }}>
              <div className="inline-flex items-center" style={{ gap: 8, padding: '7px 14px', borderRadius: 999, background: 'rgba(255,255,255,.68)', border: '1px solid #e8e6e3', backdropFilter: 'blur(10px)' }}>
                <span className="relative block flex-none rounded-full" style={{ width: 7, height: 7, background: engineStatus.color }}>
                  {engineStatus.pulse && (
                    <span className="absolute inset-0 block rounded-full" style={{ background: engineStatus.color, animation: 'dqe-pulse 2.6s ease-out infinite' }} />
                  )}
                </span>
                <span role="status" aria-live="polite" className="font-johnson-text font-bold uppercase" style={{ fontSize: '10.5px', letterSpacing: '.08em', color: '#6e6259' }}>
                  {engineStatus.label}
                </span>
              </div>
            </div>

            {/* SmartHub logo — fixed 14px under the status badge */}
            <img
              src="/sh_logo.png"
              alt="GRA SmartHub"
              className="select-none"
              draggable={false}
              style={{ width: 'clamp(160px, 15vw, 220px)', height: 'auto', maxHeight: '9vh', objectFit: 'contain', marginTop: 14, alignSelf: 'flex-start' }}
            />

            {/* Hero typography — stacked from the top so gaps stay fixed; the
                leftover vertical space falls below the text instead of being
                distributed between the badge, logo and headline */}
            <FitToBox className="flex-1" align="start">
            <div style={{ padding: 'clamp(12px,3vh,28px) 0 clamp(8px,2vh,20px)' }}>
              <p className="font-johnson-text font-bold uppercase" style={{ fontSize: 11, letterSpacing: '.26em', color: '#0f68b2', margin: '0 0 clamp(10px,3vh,28px)' }}>
                Data Quality Suite
              </p>
              <h1 className="font-johnson-display" style={{ fontWeight: 700, fontSize: 'clamp(32px,min(4.6vw,7.5vh),72px)', lineHeight: .97, color: '#312c2a', margin: 0, letterSpacing: '-.025em' }}>
                Data Quality
              </h1>
              <h1 className="font-johnson-display italic" style={{ fontWeight: 300, fontSize: 'clamp(40px,4.6vw,72px)', lineHeight: .97, color: '#eb1700', margin: 0, letterSpacing: '-.025em' }}>
                Engine.
              </h1>
              <div style={{ margin: 'clamp(12px,3vh,28px) 0' }}>
                <div style={{ width: 52, height: 3, background: '#eb1700' }} />
              </div>
              <p className="font-johnson-text" style={{ fontWeight: 300, fontSize: 'clamp(14px,1.1vw,17px)', lineHeight: 1.55, color: '#6e6259', maxWidth: 380, margin: '0 0 clamp(12px,3.5vh,36px)' }}>
                IT checks, source-to-target validation and business rules, plus
                live IND/CTA and Safety quality dashboards, in one place.
              </p>

              {/* Connected environments */}
              <div className="flex items-center flex-wrap" style={{ gap: 10 }}>
                <span className="font-johnson-text font-bold uppercase" style={{ fontSize: 10, letterSpacing: '.14em', color: '#a39992', marginRight: 4 }}>
                  Connected
                </span>
                {[
                  { label: 'DEV', dot: '#69d0ff' },
                  { label: 'QA',  dot: '#0f68b2' },
                  { label: 'PRD', dot: '#328714' },
                ].map(env => (
                  <span
                    key={env.label}
                    className="inline-flex items-center font-johnson-text font-bold"
                    style={{ gap: 6, padding: '5px 12px', borderRadius: 999, background: 'rgba(255,255,255,.72)', border: '1px solid #e8e6e3', fontSize: 11, letterSpacing: '.08em', color: '#312c2a' }}
                  >
                    <span className="block flex-none rounded-full" style={{ width: 6, height: 6, background: env.dot }} />
                    {env.label}
                  </span>
                ))}
              </div>
            </div>
            </FitToBox>

            {/* Footer */}
            <p className="font-johnson-text" style={{ fontWeight: 300, fontSize: 11, color: '#a39992', margin: 0, letterSpacing: '.02em' }}>
              Confidential · Internal Use Only · © {new Date().getFullYear()} Regulatory Integrated Data · Johnson &amp; Johnson
            </p>
          </div>
        </div>

        {/* ═══ RIGHT PANEL ═══ */}
        <div
          className="relative flex-1 flex flex-col bg-white overflow-hidden"
          style={{ backgroundImage: 'radial-gradient(circle, rgba(203,196,188,.22) 1px, transparent 1px)', backgroundSize: '24px 24px', borderLeft: '1px solid #e8e6e3' }}
        >
          <FitToBox className="flex-1">
          <div className="mx-auto w-full" style={{ padding: 'clamp(12px,4vh,56px) 52px', maxWidth: 480 }}>

            {/* Compact hero — shown only when the left panel is hidden (small screens) */}
            <div className="lg:hidden text-center mb-8">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-jj-red shadow-lg mb-4">
                <Icon src={shieldCheckIcon} alt="Shield" className="w-8 h-8 text-white" />
              </div>
              <h1 className="font-johnson-display text-2xl text-jj-gray-08" style={{ lineHeight: '110%' }}>
                Data Quality Engine
              </h1>
            </div>

            <p className="font-johnson-text font-bold uppercase" style={{ fontSize: '10.5px', letterSpacing: '.22em', color: '#a39992', margin: '0 0 14px' }}>
              Validation Suite
            </p>
            <h2 className="font-johnson-display" style={{ fontWeight: 700, fontSize: 26, lineHeight: 1.08, color: '#312c2a', margin: '0 0 8px', letterSpacing: '-.01em' }}>
              Choose your check type
            </h2>
            <p className="font-johnson-text" style={{ fontWeight: 400, fontSize: 14, color: '#81766f', margin: '0 0 clamp(12px,3.5vh,36px)', lineHeight: 1.5 }}>
              Pick a suite to open its latest results.
            </p>

            {/* Suites: one click opens the suite */}
            <ul className="flex flex-col list-none p-0 m-0" style={{ gap: 'clamp(6px,1.4vh,14px)' }}>
              {checkTypeOptions.map(item => {
                return (
                  <li key={item.value}>
                    <button
                      type="button"
                      onClick={() => openCheckType(item.value)}
                      onMouseEnter={() => preloadSuite(item.value)}
                      onFocus={() => preloadSuite(item.value)}
                      className="group flex items-center w-full text-left rounded-[14px] border-[1.5px] border-[#e8e6e3] bg-[#faf9f8] shadow-[0_1px_3px_rgba(49,44,42,.04)] transition-[transform,box-shadow,border-color,background-color] duration-200 ease-out hover:border-jj-red hover:bg-[#fff5f4] hover:translate-x-[3px] hover:shadow-[0_10px_28px_-12px_rgba(235,23,0,.28)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-jj-red focus-visible:ring-offset-2"
                      style={{ gap: 18, padding: 'clamp(8px,1.8vh,18px) 20px' }}
                    >
                      <span
                        aria-hidden="true"
                        className="flex-none text-right font-johnson-display italic text-[#cbc4bc] transition-colors duration-200 group-hover:text-jj-red"
                        style={{ fontWeight: 300, fontSize: 30, lineHeight: 1, width: 32 }}
                      >
                        {item.num}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="flex items-center" style={{ gap: 10, marginBottom: 6 }}>
                          <span className="flex items-center justify-center flex-none rounded-lg" style={{ width: 30, height: 30, background: 'rgba(235,23,0,.07)' }}>
                            <Icon src={item.icon} alt="" className="w-4 h-4 text-jj-red" />
                          </span>
                          <span className="font-johnson-display" style={{ fontWeight: 700, fontSize: 16, color: '#312c2a', letterSpacing: '-.01em' }}>
                            {item.label}
                          </span>
                          {item.beta && (
                            <span
                              className="flex-none font-johnson-text"
                              style={{
                                fontSize: 10, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase',
                                padding: '2px 7px', borderRadius: 999,
                                color: '#eb1700', background: 'rgba(235,23,0,.08)', border: '1px solid rgba(235,23,0,.25)',
                              }}
                            >
                              Beta
                            </span>
                          )}
                        </span>
                        <span className="block font-johnson-text" style={{ fontSize: '13.5px', color: '#6e6259', lineHeight: 1.45 }}>
                          {item.desc}
                        </span>
                      </span>
                      <span className="flex-none flex items-center justify-center" style={{ width: 20, height: 20 }}>
                        <Icon src={chevronRightIcon} alt="" className="w-4 h-4 text-jj-gray-05 opacity-60 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:opacity-100" />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

          </div>
          </FitToBox>

        </div>
      </div>
    );
  }

  // Every suite gets its own error boundary (keyed, so switching suites clears a
  // crash) and a spinner while its code downloads the first time.
  const suite = (node) => (
    <ErrorBoundary key={activeCheck}>
      <Suspense fallback={<SuiteLoading />}>{node}</Suspense>
    </ErrorBoundary>
  );

  // ── Business Checks ──
  if (activeCheck === 'Business_defined_checks') {
    if (!hasPermission('viewBusinessChecks')) return <Navigate to="/dashboard" replace />;
    return suite(<BusinessDefinedChecks onBack={resetState} />);
  }

  // ── IND/CTA Data Quality ──
  if (activeCheck === 'IND_CTA_DQ') {
    if (!hasPermission('viewIndCtaQuality')) return <Navigate to="/dashboard" replace />;
    return suite(<IndCtaDataQuality onBack={availableCheckTypes.length > 1 ? resetState : null} />);
  }

  // ── Safety ──
  if (activeCheck === 'Safety_DQ') {
    if (!hasPermission('viewSafetyDQ')) return <Navigate to="/dashboard" replace />;
    return suite(<SafetyDQ />);
  }

  // ── Data Validation ──
  if (activeCheck === 'Data_Validation') {
    if (!hasPermission('viewDataValidation')) return <Navigate to="/dashboard" replace />;
    return suite(<DataValidation onBack={resetState} />);
  }

  // Guard: user could land here via direct URL with no IT Checks permission
  if (!canViewIT) {
    return <Navigate to="/dashboard" replace />;
  }

  return suite(
    <ITChecksView
      reportData={reportData}
      availableRuns={availableRuns}
      runsMerged={runsMerged}
      newestDate={newestDate}
      oldestDate={oldestDate}
      runsLoading={runsLoading}
      isLoading={isLoading}
      loadError={loadError}
      onLoadRuns={loadReport}
      onRevalidateTable={handleRevalidateTable}
      canRefreshTable={canRefreshTable}
      canRun={hasPermission('runITChecks')}
      canSwitch={availableCheckTypes.length > 1}
      onSwitch={resetState}
    />
  );
}

export default DataQualityEngine;