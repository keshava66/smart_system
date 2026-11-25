import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft, ChevronRight, Download, ExternalLink, FileText, Images, Mail, Maximize2, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import { fmtN } from './paneLib';

// The Preview tab of the cell viewer: a value read the way a person would,
// not as JSON. Images (base64 or data URLs) are drawn, PDFs open, links,
// e-mails, dates, colours and sizes read as what they are, long text reads
// as text, lists of alike records become tables, other lists become cards.
//
// Everything here is plain DOM and CSS. Motion is opacity and transform only
// and nothing blurs, so it stays smooth on machines with no GPU; long lists
// render a page at a time and off-screen cards skip layout (content-visibility).

const CARDS_PAGE = 10;
const TABLE_PAGE = 100;
const CHIPS_MAX = 60;
const TEXT_CLAMP = 1_200;
const MEDIA_MAX = 500;
const NESTED_JSON_MAX = 1_000_000;

/* ------------------------------ detection ------------------------------ */

const IMAGE_MAGIC = [
  ['iVBORw0KGgo', 'image/png'], ['/9j/', 'image/jpeg'], ['R0lGOD', 'image/gif'],
  ['UklGR', 'image/webp'], ['Qk', 'image/bmp'], ['PHN2Zy', 'image/svg+xml'], ['AAABAA', 'image/x-icon'],
];
const DATA_IMAGE = /^data:(image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml|x-icon|avif));base64,/i;
const B64_HEAD = /^[A-Za-z0-9+/\r\n]+$/;
const B64_TAIL = /^[A-Za-z0-9+/\r\n]*={0,2}$/;
// Short strings are checked whole; long ones by their start and end.
const looksBase64 = (s) => s.length >= 64 && (s.length <= 4_000 ? B64_TAIL.test(s) : B64_HEAD.test(s.slice(0, 2_000)) && B64_TAIL.test(s.slice(-200)));
const b64Bytes = (s) => Math.floor((s.replace(/[\r\n=]/g, '').length * 3) / 4);

// The checks below run on the same (sometimes megabyte) strings many times
// per render, so their answers are kept for the last few hundred strings.
const cached = (fn) => {
  const memo = new Map();
  return (s) => {
    if (typeof s !== 'string' || s.length < 64) return fn(s);
    if (memo.has(s)) return memo.get(s);
    const r = fn(s);
    if (memo.size > 400) memo.delete(memo.keys().next().value);
    memo.set(s, r);
    return r;
  };
};

// { mime, src, bytes } for a string that is an image, else null.
const imageOf = cached((s) => {
  if (typeof s !== 'string' || s.length < 64) return null;
  const d = DATA_IMAGE.exec(s);
  if (d) return { mime: d[1].toLowerCase(), src: s, bytes: b64Bytes(s.slice(d[0].length)) };
  if (!looksBase64(s)) return null;
  const hit = IMAGE_MAGIC.find(([head]) => s.startsWith(head));
  if (!hit || (hit[1] === 'image/webp' && !atobSafe(s.slice(0, 16)).includes('WEBP'))) return null;
  return { mime: hit[1], src: `data:${hit[1]};base64,${s.replace(/[\r\n]/g, '')}`, bytes: b64Bytes(s) };
});
const atobSafe = (s) => { try { return atob(s); } catch { return ''; } };
const isPdf = (s) => typeof s === 'string' && s.length >= 64 && (s.startsWith('JVBERi0') || /^data:application\/pdf;base64,/i.test(s));

const URL_RE = /^https?:\/\/[^\s<>"]+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BYTES_KEY = /(?:^|_)(?:bytes?|size|length_bytes|file_size)$/i;
const TIME_KEY = /(?:_at|_time|_ts|timestamp|date|_on)$/i;

const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v);
const isScalar = (v) => v === null || typeof v !== 'object';
const isLongText = (s) => typeof s === 'string' && (s.length > 160 || s.includes('\n'));
const nestedJson = cached((s) => {
  if (typeof s !== 'string' || s.length > NESTED_JSON_MAX || !/^\s*[[{]/.test(s)) return undefined;
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : undefined; } catch { return undefined; }
});
// Shown in a row of a property list (as opposed to a section of its own).
const isInline = (v) => isScalar(v) && !(typeof v === 'string' && (isLongText(v) || imageOf(v) || isPdf(v) || nestedJson(v)));

const humanize = (k) => {
  if (typeof k === 'number') return `#${k + 1}`;
  const s = String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : String(k);
};
const singular = (k) => {
  const s = humanize(k);
  if (/ies$/i.test(s)) return s.slice(0, -3) + 'y';
  if (/(ses|xes|ches|shes)$/i.test(s)) return s.slice(0, -2);
  if (/s$/i.test(s) && !/ss$/i.test(s)) return s.slice(0, -1);
  return s;
};
const formatBytes = (n) => {
  if (!Number.isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};
const asDate = (v, key) => {
  if (typeof v === 'string' && DATE_RE.test(v)) { const d = new Date(v.length === 10 ? `${v}T00:00:00` : v); return Number.isNaN(d.getTime()) ? null : { d, dateOnly: v.length === 10 }; }
  if (typeof v === 'number' && key && TIME_KEY.test(String(key))) {
    if (v > 9e8 && v < 4.2e9) return { d: new Date(v * 1000) };
    if (v > 9e11 && v < 4.2e12) return { d: new Date(v) };
  }
  return null;
};
const RTF = typeof Intl !== 'undefined' && Intl.RelativeTimeFormat ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;
const relative = (d) => {
  if (!RTF) return '';
  const s = (d.getTime() - Date.now()) / 1000;
  const steps = [[60, 'second'], [60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month'], [Infinity, 'year']];
  let v = s;
  for (const [n, unit] of steps) { if (Math.abs(v) < n) return RTF.format(Math.round(v), unit); v /= n; }
  return '';
};

// Every image in the value, in document order, with what its record says about it.
const collectMedia = (root) => {
  const out = [];
  const walk = (v, path, parent) => {
    if (out.length >= MEDIA_MAX) return;
    if (typeof v === 'string') {
      const img = imageOf(v);
      if (img) {
        const meta = parent && !Array.isArray(parent) ? parent : {};
        out.push({ id: pathId(path), path, ...img, bytes: num(meta.bytes) ?? num(meta.size) ?? img.bytes, width: num(meta.width), height: num(meta.height), name: meta.name || meta.filename || meta.file_name || null });
      }
      return;
    }
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) v.forEach((c, i) => walk(c, [...path, i], v));
      else for (const [k, c] of Object.entries(v)) walk(c, [...path, k], v);
    }
  };
  walk(root, [], null);
  return out;
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pathId = (path) => path.map(p => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
// "Page 3 · Image 1": just the numbered steps, or the last name if there are none.
const shortLabel = (path) => {
  const steps = path.map((p, i) => (typeof p === 'number' ? `${singular(path[i - 1] ?? 'item')} ${p + 1}` : null)).filter(Boolean);
  return steps.length ? steps.join(' · ') : humanize(path[path.length - 1] ?? 'Image');
};
const pathLabel = (path) => path.map((p, i) => (typeof p === 'number' ? `${singular(path[i - 1] ?? 'item')} ${p + 1}` : humanize(p))).join(' › ') || 'Value';

const downloadData = (src, name) => {
  const a = document.createElement('a');
  a.href = src;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
};
const extOf = (mime) => ({ 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/x-icon': 'ico' }[mime] || mime.split('/')[1] || 'bin');
const pdfUrl = (s) => {
  const b64 = s.startsWith('data:') ? s.slice(s.indexOf(',') + 1) : s;
  const bin = atob(b64.replace(/[\r\n]/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
};

/* ------------------------------ scalars ------------------------------ */

const NUM = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 });

function Scalar({ v, k }) {
  if (v === null || v === undefined) return <span className="text-[#a39992] italic">empty</span>;
  if (typeof v === 'boolean') {
    return (
      <span className={`inline-flex items-center gap-1.5 h-[20px] px-2 rounded-full text-[11.5px] font-medium ${v ? 'bg-[#e9f6e4] text-[#286d10]' : 'bg-[#f1efed] text-[#6e6259]'}`}>
        <span className={`w-[6px] h-[6px] rounded-full ${v ? 'bg-[#3c9a1c]' : 'bg-[#a39992]'}`} />{v ? 'Yes' : 'No'}
      </span>
    );
  }
  const date = asDate(v, k);
  if (date) {
    const text = date.dateOnly ? date.d.toLocaleDateString(undefined, { dateStyle: 'medium' }) : date.d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    return <span title={String(v)} className="text-[#312c2a]">{text}<span className="ml-1.5 text-[#8a7f78] text-[11.5px]">{relative(date.d)}</span></span>;
  }
  if (typeof v === 'number') {
    const bytes = k && BYTES_KEY.test(String(k)) && Number.isInteger(v) && v >= 1024;
    return (
      <span className="font-mono tabular-nums text-[#0b5cad]">
        {NUM.format(v)}{bytes && <span className="ml-1.5 font-johnson-text text-[11.5px] text-[#8a7f78]">{formatBytes(v)}</span>}
      </span>
    );
  }
  const s = String(v);
  if (!s) return <span className="text-[#a39992] italic">blank</span>;
  if (URL_RE.test(s)) {
    return (
      <a href={s} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 max-w-full text-[var(--sig-ink)] underline decoration-[var(--sig-mid)] underline-offset-2 hover:decoration-[var(--sig)] [overflow-wrap:anywhere]">
        {s}<ExternalLink size={11} className="flex-shrink-0" />
      </a>
    );
  }
  if (EMAIL_RE.test(s)) {
    return <a href={`mailto:${s}`} className="inline-flex items-center gap-1 text-[var(--sig-ink)] hover:underline"><Mail size={11} />{s}</a>;
  }
  if (COLOR_RE.test(s)) {
    return <span className="inline-flex items-center gap-1.5 font-mono"><span className="w-[14px] h-[14px] rounded-[4px] border border-black/10" style={{ background: s }} />{s}</span>;
  }
  if (UUID_RE.test(s)) return <span className="font-mono text-[12px] text-[#4a423e]">{s}</span>;
  return <span className="text-[#312c2a] [overflow-wrap:anywhere]">{s}</span>;
}

/* ------------------------------ blocks ------------------------------ */

function Prose({ text }) {
  const [all, setAll] = useState(false);
  const cut = text.length > TEXT_CLAMP && !all;
  const words = useMemo(() => (text.match(/\S+/g) || []).length, [text]);
  return (
    <div>
      <div className={`relative max-w-[82ch] whitespace-pre-wrap [overflow-wrap:anywhere] text-[13.5px] leading-[1.7] text-[#312c2a] ${cut ? 'vv-fade' : ''}`}>
        {cut ? `${text.slice(0, TEXT_CLAMP)}…` : text}
      </div>
      <div className="mt-2 flex items-center gap-3 text-[11.5px] text-[#8a7f78]">
        <span>{fmtN(words)} words · {fmtN(text.length)} characters</span>
        {text.length > TEXT_CLAMP && (
          <button type="button" onClick={() => setAll(a => !a)} className="font-medium text-[var(--sig-ink)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sig-ring)] rounded">
            {all ? 'Show less' : 'Read all'}
          </button>
        )}
      </div>
    </div>
  );
}

function Figure({ img, id, caption, onOpen }) {
  const [failed, setFailed] = useState(false);
  const [dims, setDims] = useState(null);
  const w = caption?.width ?? dims?.w;
  const h = caption?.height ?? dims?.h;
  const name = caption?.name || `image.${extOf(img.mime)}`;
  return (
    <figure className="m-0 group/fig">
      <button
        type="button"
        onClick={() => !failed && onOpen(id)}
        className="vv-checker relative block w-full rounded-[10px] border border-[#e8e6e3] overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sig-ring)] cursor-zoom-in"
        aria-label={`Open ${name} full size`}
      >
        {failed ? (
          <div className="h-[140px] flex items-center justify-center text-[12px] text-[#8a7f78]">This image could not be read</div>
        ) : (
          <img
            src={img.src}
            alt={name}
            loading="lazy"
            decoding="async"
            onLoad={e => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setFailed(true)}
            className="block mx-auto max-h-[420px] max-w-full object-contain"
          />
        )}
        {!failed && (
          <span className="absolute top-2 right-2 inline-flex items-center justify-center w-[28px] h-[28px] rounded-lg bg-[#312c2a]/80 text-white opacity-0 group-hover/fig:opacity-100 transition-opacity duration-150">
            <Maximize2 size={13} />
          </span>
        )}
      </button>
      <figcaption className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px] text-[#6e6259]">
        <Chip>{img.mime.replace('image/', '').toUpperCase()}</Chip>
        {w && h && <Chip>{fmtN(w)} × {fmtN(h)}</Chip>}
        <Chip>{formatBytes(caption?.bytes ?? img.bytes)}</Chip>
        <button type="button" onClick={() => downloadData(img.src, name)} className="ml-auto inline-flex items-center gap-1 font-medium text-[var(--sig-ink)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sig-ring)] rounded">
          <Download size={12} />Save image
        </button>
      </figcaption>
    </figure>
  );
}

function PdfCard({ s, name }) {
  const bytes = b64Bytes(s.startsWith('data:') ? s.slice(s.indexOf(',') + 1) : s);
  const open = () => { const u = pdfUrl(s); window.open(u, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(u), 60_000); };
  const save = () => { const u = pdfUrl(s); downloadData(u, `${name || 'document'}.pdf`); setTimeout(() => URL.revokeObjectURL(u), 10_000); };
  return (
    <div className="flex items-center gap-3 p-3 rounded-[10px] border border-[#e8e6e3] bg-white">
      <span className="w-[38px] h-[38px] flex-shrink-0 rounded-lg bg-[#fdeceb] text-[#b42318] flex items-center justify-center"><FileText size={18} /></span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-[#312c2a]">PDF document</div>
        <div className="text-[11.5px] text-[#8a7f78]">{formatBytes(bytes)}</div>
      </div>
      <button type="button" onClick={open} className="vv-btn">Open</button>
      <button type="button" onClick={save} className="vv-btn">Save</button>
    </div>
  );
}

const Chip = ({ children }) => <span className="inline-flex items-center h-[20px] px-2 rounded-full bg-[#f1efed] text-[11px] text-[#6e6259] tabular-nums">{children}</span>;

function Section({ title, meta, depth, children, defaultOpen, className = '' }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`${depth === 0 ? 'vv-card' : 'mt-1'} ${className}`}>
      <h4 className="m-0">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          className={`w-full flex items-center gap-2 text-left rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sig-ring)] ${depth === 0 ? 'px-4 py-3' : 'py-1.5'}`}
        >
          <ChevronRight size={14} className={`flex-shrink-0 text-[#8a7f78] transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
          <span className={`font-johnson-display font-bold text-[#312c2a] ${depth === 0 ? 'text-[14px]' : 'text-[13px]'}`}>{title}</span>
          {meta && <span className="text-[11.5px] text-[#8a7f78] font-normal">{meta}</span>}
        </button>
      </h4>
      {open && <div className={`vv-in-soft ${depth === 0 ? 'px-4 pb-4' : 'pl-[22px] pb-2'}`}>{children}</div>}
    </section>
  );
}

const metaOf = (v) => {
  if (Array.isArray(v)) return v.length ? `${fmtN(v.length)} ${v.length === 1 ? 'item' : 'items'}` : 'empty';
  if (v && typeof v === 'object') { const n = Object.keys(v).length; return `${fmtN(n)} ${n === 1 ? 'field' : 'fields'}`; }
  if (typeof v === 'string') {
    if (imageOf(v)) return 'image';
    if (isPdf(v)) return 'PDF';
    if (nestedJson(v)) return 'JSON in text';
    return `${fmtN(v.length)} characters`;
  }
  return '';
};

/* ------------------------------ structure ------------------------------ */

const isEmptyBox = (v) => v && typeof v === 'object' && (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);

function Fields({ obj, path, depth, ctx }) {
  const entries = Object.entries(obj);
  const inline = entries.filter(([, v]) => isInline(v));
  const empties = entries.filter(([, v]) => isEmptyBox(v)).map(([k]) => k);
  const blocks = entries.filter(([, v]) => !isInline(v) && !isEmptyBox(v));
  if (!entries.length) return <Empty>No fields</Empty>;
  return (
    <div>
      {inline.length > 0 && (
        <dl className="m-0 grid grid-cols-[minmax(110px,max-content)_minmax(0,1fr)] max-sm:grid-cols-1 gap-x-6 gap-y-0 text-[13px]">
          {inline.map(([k, v]) => (
            <div key={k} className="contents">
              <dt title={k} className="py-1.5 text-[12px] text-[#766a63] max-sm:pb-0 border-b border-[#f1efed] max-sm:border-0">{humanize(k)}</dt>
              <dd className="m-0 py-1.5 min-w-0 border-b border-[#f1efed]"><Scalar v={v} k={k} /></dd>
            </div>
          ))}
        </dl>
      )}
      {blocks.map(([k, v]) => (
        <Section key={k} title={humanize(k)} meta={metaOf(v)} depth={depth + 1} defaultOpen={ctx.openDepth > depth + 1}>
          <Node v={v} k={k} path={[...path, k]} depth={depth + 1} ctx={ctx} />
        </Section>
      ))}
      {empties.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px] text-[#8a7f78]">
          <span>Empty</span>
          {empties.map(k => <span key={k} title={k} className="inline-flex items-center h-[20px] px-2 rounded-full border border-dashed border-[#d5cfc9]">{humanize(k)}</span>)}
        </div>
      )}
    </div>
  );
}

const Empty = ({ children }) => <div className="py-1 text-[12.5px] text-[#a39992] italic">{children}</div>;

// An object that carries an image: the picture first, its record beside it.
function ImageRecord({ obj, imgKey, path, depth, ctx }) {
  const img = imageOf(obj[imgKey]);
  const rest = Object.fromEntries(Object.entries(obj).filter(([k]) => k !== imgKey));
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(200px,280px)] items-start">
      <Figure img={img} id={pathId([...path, imgKey])} caption={{ width: num(obj.width), height: num(obj.height), bytes: num(obj.bytes) ?? num(obj.size) ?? undefined, name: obj.name || obj.filename || obj.file_name }} onOpen={ctx.onOpenImage} />
      {Object.keys(rest).length > 0 && <Fields obj={rest} path={path} depth={depth} ctx={ctx} />}
    </div>
  );
}

const HEADING_KEYS = ['title', 'name', 'label', 'filename', 'file_name', 'page_number', 'page', 'number', 'id', 'key'];
const headingOf = (obj, parentKey, i) => {
  const unit = singular(parentKey ?? 'item');
  for (const h of HEADING_KEYS) {
    const v = obj[h];
    if ((typeof v === 'string' && v && v.length <= 80) || typeof v === 'number') {
      return /number|page|^id$/.test(h) && typeof v === 'number' ? `${unit} ${v}` : String(v);
    }
  }
  return `${unit} ${i + 1}`;
};

function Cards({ arr, k, path, depth, ctx }) {
  const [shown, setShown] = useState(CARDS_PAGE);
  return (
    <div className="space-y-3">
      {arr.slice(0, shown).map((item, i) => (
        <Section key={i} className="vv-cv" title={item && typeof item === 'object' ? headingOf(item, k, i) : `${singular(k ?? 'item')} ${i + 1}`} meta={metaOf(item)} depth={0} defaultOpen={(i < 3 && ctx.openDepth > 0) || ctx.openDepth > 3}>
          <Node v={item} k={i} path={[...path, i]} depth={depth + 1} ctx={ctx} />
        </Section>
      ))}
      {arr.length > shown && <More left={arr.length - shown} page={CARDS_PAGE} onMore={() => setShown(s => s + CARDS_PAGE)} />}
    </div>
  );
}

function More({ left, page, onMore }) {
  return (
    <div className="pt-1 text-center">
      <button type="button" onClick={onMore} className="vv-btn">Show {fmtN(Math.min(page, left))} more · {fmtN(left)} left</button>
    </div>
  );
}

function Table({ arr, cols }) {
  const [shown, setShown] = useState(TABLE_PAGE);
  return (
    <div>
      <div className="overflow-auto max-h-[520px] rounded-[10px] border border-[#e8e6e3] bg-white">
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="sticky top-0 z-[1] bg-[#f8f7f5]">
            <tr>
              <th className="px-3 py-2 text-right font-medium text-[11px] text-[#a39992] border-b border-[#e8e6e3] w-[1%]">#</th>
              {cols.map(c => <th key={c} title={c} className="px-3 py-2 text-left font-medium text-[11.5px] text-[#6e6259] border-b border-[#e8e6e3] whitespace-nowrap">{humanize(c)}</th>)}
            </tr>
          </thead>
          <tbody>
            {arr.slice(0, shown).map((row, i) => (
              <tr key={i} className="hover:bg-[#faf9f8]">
                <td className="px-3 py-1.5 text-right text-[11px] tabular-nums text-[#b8afa8] border-b border-[#f1efed]">{i + 1}</td>
                {cols.map(c => {
                  const v = row?.[c];
                  return (
                    <td key={c} className="px-3 py-1.5 border-b border-[#f1efed] align-top max-w-[360px]">
                      {v === undefined ? <span className="text-[#d5cfc9]">—</span> : isScalar(v) && !isLongText(v) ? <Scalar v={v} k={c} />
                        : <span className="text-[#8a7f78] line-clamp-2" title={typeof v === 'string' ? v.slice(0, 600) : undefined}>{typeof v === 'string' ? v : metaOf(v)}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {arr.length > shown && <div className="mt-2"><More left={arr.length - shown} page={TABLE_PAGE} onMore={() => setShown(s => s + TABLE_PAGE)} /></div>}
    </div>
  );
}

// Same-shaped flat records read best as a table.
const tableColumns = (arr) => {
  if (arr.length < 2 || !arr.every(r => r && typeof r === 'object' && !Array.isArray(r))) return null;
  const sample = arr.slice(0, 50);
  const count = new Map();
  for (const r of sample) for (const [k, v] of Object.entries(r)) {
    if (!isScalar(v) || (typeof v === 'string' && (imageOf(v) || isPdf(v) || v.length > 400))) return null;
    count.set(k, (count.get(k) || 0) + 1);
  }
  const cols = [...count.keys()];
  if (!cols.length || cols.length > 24) return null;
  const shared = cols.filter(c => count.get(c) >= sample.length * 0.6).length;
  return shared / cols.length >= 0.6 ? cols : null;
};

function List({ arr, k, path, depth, ctx }) {
  if (!arr.length) return <Empty>Empty list</Empty>;
  if (arr.every(v => isInline(v))) {
    const short = arr.length <= CHIPS_MAX && arr.every(v => String(v).length <= 40);
    if (short) {
      return (
        <div className="flex flex-wrap gap-1.5">
          {arr.map((v, i) => <span key={i} className="inline-flex items-center min-h-[24px] px-2.5 rounded-full border border-[#e8e6e3] bg-white text-[12.5px]"><Scalar v={v} /></span>)}
        </div>
      );
    }
    return (
      <ol className="m-0 pl-0 list-none space-y-1">
        {arr.slice(0, 500).map((v, i) => (
          <li key={i} className="flex gap-3 text-[13px]"><span className="w-[32px] flex-shrink-0 text-right tabular-nums text-[#b8afa8]">{i + 1}</span><Scalar v={v} /></li>
        ))}
        {arr.length > 500 && <li className="pl-[44px] text-[12px] text-[#8a7f78]">and {fmtN(arr.length - 500)} more (see Tree or Raw)</li>}
      </ol>
    );
  }
  const cols = tableColumns(arr);
  if (cols) return <Table arr={arr} cols={cols} />;
  return <Cards arr={arr} k={k} path={path} depth={depth} ctx={ctx} />;
}

const Node = memo(function Node({ v, k, path, depth, ctx }) {
  const kind = kindOf(v);
  if (kind === 'array') return <List arr={v} k={k} path={path} depth={depth} ctx={ctx} />;
  if (kind === 'object') {
    const imgKey = Object.keys(v).find(key => imageOf(v[key]));
    return imgKey ? <ImageRecord obj={v} imgKey={imgKey} path={path} depth={depth} ctx={ctx} /> : <Fields obj={v} path={path} depth={depth} ctx={ctx} />;
  }
  if (typeof v === 'string') {
    const img = imageOf(v);
    if (img) return <Figure img={img} id={pathId(path)} onOpen={ctx.onOpenImage} />;
    if (isPdf(v)) return <PdfCard s={v} name={typeof k === 'string' ? k : null} />;
    const inner = nestedJson(v);
    if (inner) return <Node v={inner} k={k} path={path} depth={depth} ctx={ctx} />;
    if (isLongText(v)) return <Prose text={v} />;
  }
  return <Scalar v={v} k={k} />;
});

/* ------------------------------ overview ------------------------------ */

const statsOf = (root, media) => {
  let words = 0;
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < 200_000) {
    const v = stack.pop();
    seen += 1;
    if (typeof v === 'string') { if (v.length > 40 && !imageOf(v) && !isPdf(v)) words += (v.match(/\S+/g) || []).length; }
    else if (v && typeof v === 'object') for (const c of Array.isArray(v) ? v : Object.values(v)) stack.push(c);
  }
  const chips = [];
  if (root && typeof root === 'object' && !Array.isArray(root)) {
    for (const [k, v] of Object.entries(root)) if (Array.isArray(v) && v.length) chips.push(`${fmtN(v.length)} ${v.length === 1 ? singular(k).toLowerCase() : humanize(k).toLowerCase()}`);
  } else if (Array.isArray(root)) chips.push(`${fmtN(root.length)} items`);
  if (media.length) chips.push(`${fmtN(media.length)}${media.length >= MEDIA_MAX ? '+' : ''} ${media.length === 1 ? 'image' : 'images'}`);
  if (words) chips.push(`${fmtN(words)} words`);
  return chips;
};

function Gallery({ media, onOpen }) {
  const [shown, setShown] = useState(24);
  return (
    <div className="vv-card px-4 py-3">
      <div className="flex items-center gap-2 mb-2.5">
        <Images size={14} className="text-[var(--sig-ink)]" />
        <span className="font-johnson-display font-bold text-[14px] text-[#312c2a]">Images</span>
        <span className="text-[11.5px] text-[#8a7f78]">{fmtN(media.length)}</span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1.5 -mx-1 px-1 snap-x">
        {media.slice(0, shown).map(m => (
          <button
            key={m.id}
            type="button"
            onClick={() => onOpen(m.id)}
            title={pathLabel(m.path)}
            className="vv-checker group/th relative flex-shrink-0 snap-start w-[112px] h-[84px] rounded-[9px] border border-[#e8e6e3] overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sig-ring)]"
          >
            <img src={m.src} alt="" loading="lazy" decoding="async" className="w-full h-full object-contain transition-transform duration-200 group-hover/th:scale-[1.04]" />
            <span className="absolute left-1 bottom-1 px-1.5 rounded bg-[#312c2a]/75 text-[10px] text-white tabular-nums">{shortLabel(m.path.slice(0, -1))}</span>
          </button>
        ))}
        {media.length > shown && (
          <button type="button" onClick={() => setShown(s => s + 24)} className="flex-shrink-0 w-[112px] h-[84px] rounded-[9px] border border-dashed border-[#d5cfc9] text-[12px] font-medium text-[var(--sig-ink)] hover:bg-[#faf9f8]">
            +{fmtN(media.length - shown)} more
          </button>
        )}
      </div>
    </div>
  );
}

export function Preview({ value, openDepth = 4 }) {
  const media = useMemo(() => collectMedia(value), [value]);
  const [lightbox, setLightbox] = useState(-1);
  const onOpenImage = useCallback((id) => setLightbox(media.findIndex(m => m.id === id)), [media]);
  const closeLightbox = useCallback(() => setLightbox(-1), []);
  const ctx = useMemo(() => ({ onOpenImage, openDepth }), [onOpenImage, openDepth]);
  const chips = useMemo(() => statsOf(value, media), [value, media]);
  const isRecord = value && typeof value === 'object';
  return (
    <div className="vv-in-soft mx-auto w-full max-w-[1040px] px-4 sm:px-6 py-5 space-y-4">
      <style>{PREVIEW_CSS}</style>
      {lightbox >= 0 && createPortal(<Lightbox items={media} index={lightbox} onIndex={setLightbox} onClose={closeLightbox} />, document.body)}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map(c => <span key={c} className="inline-flex items-center h-[24px] px-2.5 rounded-full bg-white border border-[#e8e6e3] text-[12px] text-[#4a423e] tabular-nums">{c}</span>)}
        </div>
      )}
      {media.length > 1 && <Gallery media={media} onOpen={onOpenImage} />}
      {isRecord && !Array.isArray(value) ? (
        <TopFields obj={value} ctx={ctx} />
      ) : (
        <div className="vv-card p-4"><Node v={value} path={[]} depth={0} ctx={ctx} /></div>
      )}
    </div>
  );
}

// The top level: its simple fields as one card, every bigger field as a card of its own.
function TopFields({ obj, ctx }) {
  const entries = Object.entries(obj);
  const inline = Object.fromEntries(entries.filter(([, v]) => isInline(v)));
  const blocks = entries.filter(([, v]) => !isInline(v));
  const groups = entries.filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isInline));
  const groupKeys = new Set(groups.map(([k]) => k));
  return (
    <>
      {(Object.keys(inline).length > 0 || groups.length > 0) && (
        <div className={`grid gap-4 ${(Object.keys(inline).length > 0 ? 1 : 0) + groups.length > 1 ? 'md:grid-cols-2' : ''}`}>
          {Object.keys(inline).length > 0 && (
            <div className="vv-card px-4 py-3">
              <div className="mb-1 font-johnson-display font-bold text-[14px] text-[#312c2a]">Details</div>
              <Fields obj={inline} path={[]} depth={0} ctx={ctx} />
            </div>
          )}
          {groups.map(([k, v]) => (
            <div key={k} className="vv-card px-4 py-3">
              <div className="mb-1 flex items-baseline gap-2"><span className="font-johnson-display font-bold text-[14px] text-[#312c2a]">{humanize(k)}</span><span className="text-[11.5px] text-[#8a7f78]">{metaOf(v)}</span></div>
              <Fields obj={v} path={[k]} depth={0} ctx={ctx} />
            </div>
          ))}
        </div>
      )}
      {blocks.filter(([k]) => !groupKeys.has(k)).map(([k, v]) => (
        Array.isArray(v) && v.length && v.every(x => x && typeof x === 'object' && !Array.isArray(x)) && !tableColumns(v) ? (
          <div key={k}>
            <div className="mb-2 mt-1 flex items-baseline gap-2 px-1">
              <span className="font-johnson-display font-bold text-[15px] text-[#312c2a]">{humanize(k)}</span>
              <span className="text-[11.5px] text-[#8a7f78]">{metaOf(v)}</span>
            </div>
            <Cards arr={v} k={k} path={[k]} depth={0} ctx={ctx} />
          </div>
        ) : (
          <Section key={k} title={humanize(k)} meta={metaOf(v)} depth={0} defaultOpen={ctx.openDepth > 0}>
            <Node v={v} k={k} path={[k]} depth={0} ctx={ctx} />
          </Section>
        )
      ))}
    </>
  );
}

/* ------------------------------ lightbox ------------------------------ */

function Lightbox({ items, index, onIndex, onClose }) {
  const [actual, setActual] = useState(false);
  const item = items[index];
  useEffect(() => { setActual(false); }, [index]);
  useEffect(() => {
    // Capture phase, so Escape closes this and not the viewer under it.
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowRight' && items.length > 1) { e.preventDefault(); onIndex((index + 1) % items.length); }
      else if (e.key === 'ArrowLeft' && items.length > 1) { e.preventDefault(); onIndex((index - 1 + items.length) % items.length); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [index, items.length, onIndex, onClose]);
  if (!item) return null;
  const name = item.name || `${pathLabel(item.path).replace(/ › /g, '_').replace(/\s+/g, '-')}.${extOf(item.mime)}`;
  const nav = 'absolute top-1/2 -translate-y-1/2 w-[44px] h-[44px] rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60';
  return (
    <div role="dialog" aria-modal="true" aria-label="Image" className="vv-in fixed inset-0 z-[95] flex flex-col bg-[#0f0d0c]/[.96] text-white" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex items-center gap-3 px-4 sm:px-6 h-[56px] flex-shrink-0">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{shortLabel(item.path.slice(0, -1))}<span className="ml-2 font-normal text-white/50">{pathLabel(item.path)}</span></div>
          <div className="text-[11.5px] text-white/60 tabular-nums">
            {[item.mime.replace('image/', '').toUpperCase(), item.width && item.height ? `${fmtN(item.width)} × ${fmtN(item.height)}` : null, formatBytes(item.bytes)].filter(Boolean).join(' · ')}
            {items.length > 1 && <span className="ml-2">{index + 1} / {items.length}</span>}
          </div>
        </div>
        <button type="button" onClick={() => setActual(a => !a)} className="vv-lb-btn" aria-label={actual ? 'Fit to screen' : 'Actual size'} title={actual ? 'Fit to screen' : 'Actual size'}>
          {actual ? <ZoomOut size={16} /> : <ZoomIn size={16} />}
        </button>
        <button type="button" onClick={() => downloadData(item.src, name)} className="vv-lb-btn" aria-label="Save image" title="Save image"><Download size={16} /></button>
        <button type="button" onClick={onClose} className="vv-lb-btn" aria-label="Close" title="Close (Esc)"><X size={17} /></button>
      </div>
      <div className={`relative flex-1 min-h-0 ${actual ? 'overflow-auto' : 'overflow-hidden flex items-center justify-center'} px-4 sm:px-16 pb-6`} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
        <img
          key={item.id}
          src={item.src}
          alt={name}
          decoding="async"
          onClick={() => setActual(a => !a)}
          className={`vv-pop vv-checker rounded-md ${actual ? 'max-w-none cursor-zoom-out mx-auto' : 'max-w-full max-h-full object-contain cursor-zoom-in'}`}
        />
        {items.length > 1 && !actual && (
          <>
            <button type="button" onClick={() => onIndex((index - 1 + items.length) % items.length)} className={`${nav} left-3`} aria-label="Previous image"><ChevronLeft size={22} /></button>
            <button type="button" onClick={() => onIndex((index + 1) % items.length)} className={`${nav} right-3`} aria-label="Next image"><ChevronRight size={22} /></button>
          </>
        )}
      </div>
    </div>
  );
}

// Styles the classes above use (vv-in-soft and vv-pop come with the viewer).
// Plain CSS: transforms and opacity only.
const PREVIEW_CSS = `
.vv-card { background: #fff; border: 1px solid #e8e6e3; border-radius: 14px; box-shadow: 0 1px 2px rgba(49,44,42,.04); }
.vv-cv { content-visibility: auto; contain-intrinsic-size: auto 240px; }
.vv-checker { background-color: #fff; background-image: linear-gradient(45deg,#f1efed 25%,transparent 25%),linear-gradient(-45deg,#f1efed 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#f1efed 75%),linear-gradient(-45deg,transparent 75%,#f1efed 75%); background-size: 16px 16px; background-position: 0 0,0 8px,8px -8px,-8px 0; }
.vv-fade { -webkit-mask-image: linear-gradient(180deg,#000 70%,transparent); mask-image: linear-gradient(180deg,#000 70%,transparent); }
.vv-btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border-radius: 8px; border: 1px solid #e0dbd6; background: #fff; font-size: 12px; font-weight: 500; color: #312c2a; transition: background-color .15s, border-color .15s; }
.vv-btn:hover { background: #f8f7f5; border-color: #d5cfc9; }
.vv-btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--sig-ring); }
.vv-lb-btn { width: 36px; height: 36px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; color: #fff; transition: background-color .15s; }
.vv-lb-btn:hover { background: rgba(255,255,255,.12); }
.vv-lb-btn:focus-visible { outline: none; box-shadow: 0 0 0 2px rgba(255,255,255,.6); }
@keyframes vv-in { from { opacity: 0; } to { opacity: 1; } }
.vv-in { animation: vv-in .16s ease-out both; }
`;
