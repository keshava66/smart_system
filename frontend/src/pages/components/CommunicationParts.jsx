import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import { useRBAC } from '../../context/RBACContext';
import { useAdGroupMembers } from '../../hooks/useAdGroupMembers';
import { useDirectoryPhotos } from '../../hooks/useDirectoryPhotos';
import { reducedMotion } from '../../utils/motion';

import closeIcon    from "/icons/JJ_Icon_Close.svg";
import searchIcon   from "/icons/JJ_Icon_Search_RGB.svg";
import communityIcon from "/icons/JJ_Icon_Community_RGB.svg";
import personIcon   from "/icons/JJ_Icon_Person_RGB.svg";
import { Bold, ChevronDown, Heading, IndentDecrease, IndentIncrease, Italic, Link2, List, ListOrdered } from 'lucide-react';
import {
  ADDR_RE, CLS, ICON_TONES, GRAPH, LIST_DEPTH, LIST_LINE_RE, SAFE_HREF_RE, cleanName, escapeHtml, graphToken,
  htmlToMarkup, markupToHtml, pastedHtmlToMarkup, searchDirectory, splitAddresses, tidyAddresses,
} from './communicationLib';

export const Icon = ({ src, alt = '', className = 'w-4 h-4', style, tone }) => (
  <img
    src={src}
    alt={alt}
    className={className}
    style={tone ? { filter: ICON_TONES[tone], ...style } : style}
  />
);

/* ─── Modal shell ─────────────────────────────────────────────────────────── */

/** Escape closes, a click on the backdrop closes, and both are ignored while
 *  `busy` — a send in flight should not be abandoned by a stray keypress. */
// Open modals, newest last. A modal can open on top of another (the link box
// over the AI draft), and Escape belongs to the one on top only.
const openModals = [];

/** Whether there is more below the fold of a scroll box, kept current as it
 *  scrolls, resizes or its content changes. */
const useMoreBelow = (box) => {
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const check = () => setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 24);
    check();
    el.addEventListener('scroll', check, { passive: true });
    const sizes = new ResizeObserver(check);
    sizes.observe(el);
    const content = new MutationObserver(check);
    content.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      el.removeEventListener('scroll', check);
      sizes.disconnect();
      content.disconnect();
    };
  }, [box]);
  return more;
};

export const Modal = ({
  title, subtitle, children, footer, onClose, width = 430, busy = false, scrollTopKey,
}) => {
  const close = useRef(onClose);
  close.current = onClose;
  const self = useRef(Symbol('modal'));
  const body = useRef(null);
  const moreBelow = useMoreBelow(body);

  // A new result in the same dialog (a fresh AI draft) is read from the top.
  // Instant and a frame late: the browser has just pulled the box down to keep
  // a focused field below the new content in view, and a smooth scroll would
  // lose that tug-of-war.
  useEffect(() => {
    if (!scrollTopKey) return undefined;
    const frame = requestAnimationFrame(() => { if (body.current) body.current.scrollTop = 0; });
    return () => cancelAnimationFrame(frame);
  }, [scrollTopKey]);

  const toBottom = () => {
    const el = body.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
  };

  useEffect(() => {
    const me = self.current;
    openModals.push(me);
    return () => openModals.splice(openModals.indexOf(me), 1);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || busy || openModals[openModals.length - 1] !== self.current) return;
      close.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-jj-gray-08/35 p-5"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) close.current?.(); }}
    >
      {/* The height cap is an inline style, not a class: it is the one rule
          that decides whether this thing stays on the screen, and it should not
          depend on a utility being generated. */}
      <div
        className="w-full bg-white rounded-2xl shadow-[0_24px_60px_rgba(49,44,42,0.22)]
                   flex flex-col"
        style={{ maxWidth: width, maxHeight: '86vh' }}
      >
        <div className="flex-none px-6 pt-6 pb-3.5">
          <h3 className="font-johnson-display font-medium text-[19px] leading-tight text-jj-gray-08">
            {title}
          </h3>
          {subtitle && (
            <p className="font-johnson-text text-[12.5px] text-jj-gray-06 mt-1 leading-relaxed">
              {subtitle}
            </p>
          )}
        </div>
        <div className="relative flex-1 min-h-0 flex flex-col">
          <div ref={body} className="flex-1 min-h-0 overflow-auto px-6">{children}</div>
          {/* More below the fold: a fade says so, and the chevron goes there. */}
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-white to-transparent
                        transition-opacity duration-300 ${moreBelow ? 'opacity-100' : 'opacity-0'}`}
          />
          <button
            type="button"
            onClick={toBottom}
            tabIndex={moreBelow ? 0 : -1}
            aria-hidden={!moreBelow}
            aria-label="Scroll to the bottom"
            title="Scroll to the bottom"
            className={`absolute left-1/2 bottom-2 -translate-x-1/2 size-8 rounded-full flex items-center justify-center
                        bg-white border border-jj-gray-03 text-jj-gray-07 shadow-[0_6px_16px_-8px_rgba(49,44,42,0.45)]
                        hover:text-jj-gray-08 hover:border-jj-gray-04 transition-[opacity,transform] duration-300
                        focus-visible:outline focus-visible:outline-2 focus-visible:outline-jj-blue-03 ${moreBelow
              ? 'opacity-100 translate-y-0'
              : 'opacity-0 translate-y-2 pointer-events-none'}`}
          >
            <ChevronDown size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        <div className="flex-none px-6 pt-4 pb-6 flex flex-wrap justify-end gap-2.5">
          {footer}
        </div>
      </div>
    </div>
  );
};

/** Replaces window.prompt — same job, but it looks like the rest of the portal
 *  and cannot be suppressed by a browser that has decided this tab asks too
 *  often. */
export const PromptModal = ({
  title, subtitle, label, defaultValue = '', placeholder,
  confirmLabel = 'Save', busy = false, onCancel, onConfirm, validate,
}) => {
  const [value, setValue] = useState(defaultValue);
  const [touched, setTouched] = useState(false);
  const field = useRef(null);
  const error = touched && validate ? validate(value.trim()) : null;

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  // Guarded against a second press while the first is still in the air: the
  // save behind this is a POST, and sending it twice gets a 409 back for a
  // template that saved perfectly well the first time.
  const submit = () => {
    if (busy || !value.trim()) return;
    if (validate?.(value.trim())) {
      setTouched(true);
      return;
    }
    onConfirm(value.trim());
  };

  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onCancel}
      busy={busy}
      footer={
        <>
          <button onClick={onCancel} disabled={busy} className={CLS.ghostBtn}>Cancel</button>
          <button
            onClick={submit}
            disabled={busy || !value.trim()}
            className={CLS.primaryBtn}
          >
            {busy ? 'Saving…' : confirmLabel}
          </button>
        </>
      }
    >
      {label && <label className={CLS.label}>{label}</label>}
      <input
        ref={field}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        placeholder={placeholder}
        disabled={busy}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'cc-prompt-error' : undefined}
        className={`${CLS.input} ${error ? '!border-jj-red' : ''}`}
      />
      {error && (
        <p id="cc-prompt-error" role="alert" className="mt-1.5 font-johnson-text text-[11.5px] text-jj-red">{error}</p>
      )}
    </Modal>
  );
};

/** Replaces window.confirm. `tone="danger"` for anything that destroys
 *  something — deleting a template, cancelling a queued send. */
export const ConfirmModal = ({
  title, subtitle, children, confirmLabel = 'Confirm', tone = 'default',
  busy = false, onCancel, onConfirm,
}) => (
  <Modal
    title={title}
    subtitle={subtitle}
    onClose={onCancel}
    busy={busy}
    footer={
      <>
        <button onClick={onCancel} disabled={busy} className={CLS.ghostBtn}>Cancel</button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className={
            tone === 'danger'
              ? 'px-4 py-2.5 rounded-[10px] bg-jj-red text-white font-johnson-text text-[13px] ' +
                'font-medium hover:bg-jj-maroon-05 transition-colors disabled:opacity-60'
              : CLS.primaryBtn
          }
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </>
    }
  >
    {children}
  </Modal>
);

const LIST_MARK_RE = /^(\s*)(?:[-*]\s+|\d+[.)]\s+)?/;

/** Start and end of the whole lines a selection from `from` to `to` touches. */
const lineSpan = (value, from, to = from) => {
  const start = value.lastIndexOf('\n', from - 1) + 1;
  const nextBreak = value.indexOf('\n', to);
  return [start, nextBreak === -1 ? value.length : nextBreak];
};
const MODE_KEY = 'cc.bodyEditorMode';

const readMode = () => {
  try {
    return localStorage.getItem(MODE_KEY) === 'markup' ? 'markup' : 'rich';
  } catch {
    return 'rich';
  }
};

const saveMode = (mode) => {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Storage blocked (private window, policy): the choice lasts for this visit.
  }
};

/** Whatever the admin typed into the link box, as an address the backend will
 *  link, or null. A bare address gets mailto:, anything else https://. */
const normalizeHref = (raw) => {
  const text = raw.trim();
  if (!text) return null;
  let href = text;
  if (!/^(?:https?:\/\/|mailto:)/i.test(text)) {
    href = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(text) ? `mailto:${text}` : `https://${text}`;
  }
  return SAFE_HREF_RE.test(href) ? href : null;
};

const linkError = (raw) => (normalizeHref(raw) ? null : 'Enter a web address or an email address, with no spaces.');

const TOOLBAR_BUTTON = 'size-8 rounded-lg flex items-center justify-center flex-none transition-colors ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-jj-blue-03';

const ModeSwitch = ({ mode, onChange }) => {
  return (
    <div role="group" aria-label="Editor view" className="flex items-center p-0.5 rounded-lg bg-jj-gray-02/70">
      {[['rich', 'Formatted'], ['markup', 'Markdown']].map(([key, label]) => (
        <button
          key={key}
          type="button"
          aria-pressed={mode === key}
          onClick={() => onChange(key)}
          className={`px-2 h-6 rounded-md font-johnson-text text-[11px] transition-colors focus-visible:outline
                      focus-visible:outline-2 focus-visible:outline-jj-blue-03 ${mode === key
            ? 'bg-white text-jj-gray-08 shadow-[0_1px_2px_rgba(49,44,42,0.12)]'
            : 'text-jj-gray-06 hover:text-jj-gray-08'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
};

const Toolbar = ({ groups, active, hint, invalid, mode, onModeChange, readOnly }) => {
  return (
    <div className="flex items-center gap-0.5 flex-wrap px-2 py-1.5 border-b border-jj-gray-02 bg-[#fbfaf8]"
         role="toolbar" aria-label="Formatting">
      {groups.map((group, g) => (
        <React.Fragment key={g}>
          {g > 0 && <span className="w-px h-5 bg-jj-gray-03 mx-2" aria-hidden="true" />}
          {group.map((tool) => {
            const on = Boolean(active[tool.key]);
            const Lucide = tool.lucide;
            return (
              <button
                key={tool.key}
                type="button"
                // Keeps the caret and selection in the editor while the button is pressed.
                onMouseDown={(e) => e.preventDefault()}
                onClick={tool.run}
                disabled={readOnly || tool.disabled}
                title={tool.title}
                aria-label={tool.title}
                aria-pressed={mode === 'rich' && !tool.action ? on : undefined}
                className={`${TOOLBAR_BUTTON} disabled:opacity-35 disabled:pointer-events-none ${on
                  ? 'bg-jj-gray-02 text-jj-gray-08'
                  : 'text-jj-gray-06 hover:bg-jj-gray-02 hover:text-jj-gray-08'}`}
              >
                <Lucide size={17} strokeWidth={1.6} aria-hidden="true" />
              </button>
            );
          })}
        </React.Fragment>
      ))}
      <div className="ml-auto flex items-center gap-2 pl-2">
        {hint && <span className={`${CLS.hint} text-[10.5px] tabular-nums ${invalid ? '!text-jj-red' : ''}`}>{hint}</span>}
        <ModeSwitch mode={mode} onChange={onModeChange} />
      </div>
    </div>
  );
};

/* ─── Markdown view: the raw text, for anyone who would rather type the marks ─ */

const useMarkupTools = (area, value, onChange) => {
  /* React owns the value, so the caret has to be put back by hand after the
   * re-render or it jumps to the end of the message on every button press. */
  const restore = (start, end) => {
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(start, end);
    });
  };

  const surround = (marker) => {
    const el = area.current;
    if (!el) return;
    const { selectionStart: from, selectionEnd: to } = el;
    const inner = value.slice(from, to) || 'text';
    onChange(value.slice(0, from) + marker + inner + marker + value.slice(to));
    restore(from + marker.length, from + marker.length + inner.length);
  };

  /** Stamp every line the selection touches, whole lines at a time — dragging
   *  across three lines and pressing "list" should make three bullets, not one
   *  bullet in the middle of the second. */
  const stampLines = (make) => {
    const el = area.current;
    if (!el) return;
    const [from, to] = lineSpan(value, el.selectionStart, el.selectionEnd);

    let index = 0;
    const stamped = value.slice(from, to).split('\n')
      .map((line) => {
        if (!line.trim()) return line;
        index += 1;
        return line.replace(LIST_MARK_RE, (_, indent) => indent + make(index));
      })
      .join('\n');

    onChange(value.slice(0, from) + stamped + value.slice(to));
    restore(from, from + stamped.length);
  };

  const heading = () => {
    const el = area.current;
    if (!el) return;
    const [from, to] = lineSpan(value, el.selectionStart);
    const line = value.slice(from, to);
    // Second press takes it off again.
    const next = /^#{1,3}\s+/.test(line) ? line.replace(/^#{1,3}\s+/, '') : `## ${line}`;
    onChange(value.slice(0, from) + next + value.slice(to));
    restore(from + next.length, from + next.length);
  };

  const insertLink = (href) => {
    const el = area.current;
    if (!el) return;
    const { selectionStart: from, selectionEnd: to } = el;
    const text = value.slice(from, to).replace(/[[\]\n]/g, ' ').trim() || href.replace(/^mailto:/i, '');
    const inserted = `[${text}](${href})`;
    onChange(value.slice(0, from) + inserted + value.slice(to));
    restore(from + inserted.length, from + inserted.length);
  };

  /** Two spaces on or off the front of every list line the selection touches. */
  const shiftLines = (by) => {
    const el = area.current;
    if (!el) return;
    const [from, to] = lineSpan(value, el.selectionStart, el.selectionEnd);
    const shifted = value.slice(from, to).split('\n')
      .map((line) => {
        if (!LIST_LINE_RE.test(line)) return line;
        if (by > 0) return `  ${line}`;
        return line.replace(/^ {1,2}|^\t/, '');
      })
      .join('\n');
    onChange(value.slice(0, from) + shifted + value.slice(to));
    restore(from, from + shifted.length);
  };

  return {
    indent: () => shiftLines(1),
    outdent: () => shiftLines(-1),
    bold: () => surround('**'),
    italic: () => surround('*'),
    heading,
    bullet: () => stampLines(() => '- '),
    number: () => stampLines((n) => `${n}. `),
    insertLink,
  };
};

/* ─── Formatted view: edits the message the way it will read ──────────────── */

const BLOCK_SELECTOR = 'p,div,li,h1,h2,h3,h4,h5,h6';

const selectionIn = (root) => {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !root) return null;
  const range = sel.getRangeAt(0);
  return root.contains(range.commonAncestorContainer) ? { sel, range } : null;
};

const closestIn = (root, node, selector) => {
  const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  const hit = el?.closest(selector);
  return hit && root.contains(hit) && hit !== root ? hit : null;
};

const exec = (command, arg) => document.execCommand(command, false, arg);

/** A list item can only go in a level under an item above it; Chrome's indent
 *  on a first item makes a sub-list with no parent, which the email cannot show. */
const canIndentItem = (root, node) => {
  const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  const item = el?.closest('li');
  return Boolean(item && root.contains(item) && item.previousElementSibling);
};

/** How many lists deep the node sits inside the editor: 0 outside a list. */
const listDepth = (root, node) => {
  let depth = 0;
  let el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  while (el && el !== root) {
    if (el.tagName === 'UL' || el.tagName === 'OL') depth += 1;
    el = el.parentElement;
  }
  return depth;
};

// Typed at the start of an empty line, then a space: the same marks the
// Markdown view understands, turned into the block straight away.
const SHORTCUTS = [
  [/^[-*]$/, () => exec('insertUnorderedList')],
  [/^1[.)]$/, () => exec('insertOrderedList')],
  [/^#$/, () => exec('formatBlock', '<h1>')],
  [/^##$/, () => exec('formatBlock', '<h2>')],
  [/^###$/, () => exec('formatBlock', '<h3>')],
];

const useRichEditor = (editor, value, onChange, mode) => {
  const lastEmitted = useRef(null);
  const [active, setActive] = useState({});

  // Outside text (a template, an AI draft, the Markdown view) replaces the
  // editor; the editor's own keystrokes never round-trip back into it.
  useLayoutEffect(() => {
    const el = editor.current;
    if (!el) {
      // Markdown view showing: whatever the editor held is gone, so the next
      // time it mounts it has to be filled from the value again.
      lastEmitted.current = null;
      return;
    }
    if (value === lastEmitted.current) return;
    el.innerHTML = markupToHtml(value);
    lastEmitted.current = value;
  }, [editor, value, mode]);

  const emit = useCallback(() => {
    const el = editor.current;
    if (!el) return;
    tidyAddresses(el);
    const next = htmlToMarkup(el);
    if (next === lastEmitted.current) return;
    lastEmitted.current = next;
    onChange(next);
  }, [editor, onChange]);

  const refreshActive = useCallback(() => {
    const el = editor.current;
    const hit = selectionIn(el);
    if (!hit) {
      setActive({});
      return;
    }
    const block = closestIn(el, hit.range.startContainer, 'h1,h2,h3');
    setActive({
      listDepth: listDepth(el, hit.range.startContainer),
      canIndent: canIndentItem(el, hit.range.startContainer),
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      head: Boolean(block),
      bullet: document.queryCommandState('insertUnorderedList'),
      number: document.queryCommandState('insertOrderedList'),
      link: Boolean(closestIn(el, hit.range.startContainer, 'a')),
    });
  }, [editor]);

  useEffect(() => {
    document.addEventListener('selectionchange', refreshActive);
    return () => document.removeEventListener('selectionchange', refreshActive);
  }, [refreshActive]);

  const run = (fn) => () => {
    const el = editor.current;
    if (!el) return;
    if (!selectionIn(el)) el.focus();
    // <b>/<i> and <p>, not inline styles and <div>s, so the markup maps back cleanly.
    exec('styleWithCSS', false);
    exec('defaultParagraphSeparator', 'p');
    fn();
    emit();
    refreshActive();
  };

  const indent = () => {
    const hit = selectionIn(editor.current);
    const depth = hit ? listDepth(editor.current, hit.range.startContainer) : 0;
    // The email nests three deep; past that a sub-list stops reading as one.
    if (depth > 0 && depth < LIST_DEPTH && canIndentItem(editor.current, hit.range.startContainer)) exec('indent');
  };

  const outdent = () => {
    const hit = selectionIn(editor.current);
    if (hit && listDepth(editor.current, hit.range.startContainer) > 0) exec('outdent');
  };

  const heading = () => {
    const hit = selectionIn(editor.current);
    const inHeading = hit && closestIn(editor.current, hit.range.startContainer, 'h1,h2,h3');
    exec('formatBlock', inHeading ? '<p>' : '<h2>');
  };

  // Set on focus too, so the first Enter typed makes a <p> and Ctrl+B a <b>.
  const prime = () => {
    exec('styleWithCSS', false);
    exec('defaultParagraphSeparator', 'p');
  };

  const onKeyDown = (e) => {
    const el = editor.current;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'u') {
      // Underline has no markup in the email, so it is not offered at all.
      e.preventDefault();
      return;
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const inList = selectionIn(el) && listDepth(el, selectionIn(el).range.startContainer) > 0;
      // Outside a list Tab keeps its job of moving focus on.
      if (!inList) return;
      e.preventDefault();
      run(e.shiftKey ? outdent : indent)();
      return;
    }
    if (e.key !== ' ' || e.ctrlKey || e.metaKey || e.altKey) return;
    const hit = selectionIn(el);
    if (!hit || !hit.range.collapsed) return;
    if (closestIn(el, hit.range.startContainer, 'li,h1,h2,h3')) return;
    const block = closestIn(el, hit.range.startContainer, BLOCK_SELECTOR) || el;
    const lead = document.createRange();
    lead.setStart(block, 0);
    lead.setEnd(hit.range.startContainer, hit.range.startOffset);
    const typed = lead.toString();
    const shortcut = SHORTCUTS.find(([re]) => re.test(typed));
    if (!shortcut) return;
    e.preventDefault();
    hit.sel.removeAllRanges();
    hit.sel.addRange(lead);
    exec('delete');
    run(shortcut[1])();
  };

  const onPaste = (e) => {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    // Never inserted as given: pasted HTML goes through the markup, so the
    // editor only ever holds what the email can show.
    const markup = html ? pastedHtmlToMarkup(html) : text;
    if (!markup.trim()) return;
    let fragment = markupToHtml(markup);
    // One paragraph goes in where the caret is rather than splitting the line.
    const single = /^<p>((?:(?!<\/?p>)[\s\S])*)<\/p>$/.exec(fragment);
    if (single) fragment = single[1];
    run(() => {
      exec('insertHTML', fragment);
      // Chrome copies the surrounding computed style onto what it inserts;
      // the email has no such styles, so neither does the editor.
      editor.current.querySelectorAll('[style]').forEach((node) => node.removeAttribute('style'));
    })();
  };

  const onDrop = (e) => {
    // Dropped HTML would skip the paste clean-up; dropped files have nowhere to go.
    e.preventDefault();
  };

  return { active, emit, run, heading, indent, outdent, prime, onKeyDown, onPaste, onDrop, refreshActive };
};

/** The compose body. Stored and sent as markdown-lite; shown formatted by
 *  default, with the raw markup one click away. */
export const BodyEditor = ({
  value, onChange, placeholder, rows = 9, hint, invalid = false, accent = '#eb1700', readOnly = false,
}) => {
  const [mode, setMode] = useState(readMode);
  const area = useRef(null);
  const editor = useRef(null);
  const [linkPrompt, setLinkPrompt] = useState(null);
  const savedRange = useRef(null);

  const markup = useMarkupTools(area, value, onChange);
  const rich = useRichEditor(editor, value, onChange, mode);

  const changeMode = (next) => {
    setMode(next);
    saveMode(next);
    requestAnimationFrame(() => (next === 'rich' ? editor.current : area.current)?.focus());
  };

  const openLink = () => {
    if (mode === 'rich') {
      const hit = selectionIn(editor.current);
      if (hit && closestIn(editor.current, hit.range.startContainer, 'a')) {
        rich.run(() => {
          const anchor = closestIn(editor.current, hit.range.startContainer, 'a');
          const range = document.createRange();
          range.selectNodeContents(anchor);
          hit.sel.removeAllRanges();
          hit.sel.addRange(range);
          exec('unlink');
        })();
        return;
      }
      savedRange.current = hit ? hit.range.cloneRange() : null;
    }
    setLinkPrompt({ text: mode === 'rich' ? (savedRange.current?.toString() || '') : '' });
  };

  const applyLink = (raw) => {
    const href = normalizeHref(raw);
    setLinkPrompt(null);
    if (!href) return;
    if (mode === 'markup') {
      markup.insertLink(href);
      return;
    }
    const el = editor.current;
    el.focus();
    const sel = window.getSelection();
    if (savedRange.current && el.contains(savedRange.current.commonAncestorContainer)) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
    rich.run(() => {
      const range = sel.rangeCount ? sel.getRangeAt(0) : null;
      if (range && !range.collapsed) {
        exec('createLink', href);
        return;
      }
      const label = escapeHtml(href.replace(/^mailto:/i, ''));
      exec('insertHTML', `<a href="${escapeHtml(href)}">${label}</a>&nbsp;`);
    })();
  };

  const tools = mode === 'rich'
    ? {
      bold: rich.run(() => exec('bold')),
      italic: rich.run(() => exec('italic')),
      heading: rich.run(rich.heading),
      bullet: rich.run(() => exec('insertUnorderedList')),
      number: rich.run(() => exec('insertOrderedList')),
      indent: rich.run(rich.indent),
      outdent: rich.run(rich.outdent),
    }
    : markup;
  const depth = rich.active.listDepth || 0;

  // Grouped as they read in the toolbar: inline marks | blocks | list levels | link.
  const groups = [
    [
      { key: 'bold',   lucide: Bold,   title: 'Bold (Ctrl+B)',   run: tools.bold },
      { key: 'italic', lucide: Italic, title: 'Italic (Ctrl+I)', run: tools.italic },
    ],
    [
      { key: 'head',   lucide: Heading,     title: 'Heading',       run: tools.heading },
      { key: 'bullet', lucide: List,        title: 'Bulleted list', run: tools.bullet },
      { key: 'number', lucide: ListOrdered, title: 'Numbered list', run: tools.number },
    ],
    [
      { key: 'outdent', lucide: IndentDecrease, title: 'Move list item out (Shift+Tab)', run: tools.outdent,
        action: true, disabled: mode === 'rich' && depth === 0 },
      { key: 'indent', lucide: IndentIncrease, title: 'Make a sub-item (Tab)', run: tools.indent,
        action: true, disabled: mode === 'rich' && (depth === 0 || depth >= LIST_DEPTH || !rich.active.canIndent) },
    ],
    [
      { key: 'link', lucide: Link2, title: mode === 'rich' && rich.active.link ? 'Remove link' : 'Link (Ctrl+K)', run: openLink },
    ],
  ];

  const onShortcut = (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openLink();
    }
  };

  const onMarkupKeyDown = (e) => {
    onShortcut(e);
    if (e.defaultPrevented || e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
    const [from, to] = lineSpan(value, area.current.selectionStart);
    // Only list lines take Tab; elsewhere it moves focus on as usual.
    if (!LIST_LINE_RE.test(value.slice(from, to))) return;
    e.preventDefault();
    (e.shiftKey ? markup.outdent : markup.indent)();
  };

  const minHeight = `${Math.max(rows, 4) * 22 + 24}px`;

  return (
    <div
      className={`rounded-xl border bg-white overflow-hidden transition-shadow ${invalid
        ? 'border-jj-red ring-[3px] ring-jj-red/10'
        : 'border-jj-gray-03 focus-within:border-jj-red focus-within:ring-[3px] focus-within:ring-jj-red/[0.08]'}`}
    >
      <Toolbar
        groups={groups}
        active={mode === 'rich' ? rich.active : {}}
        hint={hint || (mode === 'markup' ? '**bold** · *italic* · - list · ## heading' : null)}
        invalid={invalid}
        mode={mode}
        onModeChange={changeMode}
        readOnly={readOnly}
      />

      {mode === 'rich' ? (
        <div className="relative">
          {!value.trim() && (
            <div aria-hidden="true"
                 className="absolute inset-0 px-3.5 py-3 pointer-events-none whitespace-pre-wrap overflow-hidden
                            font-johnson-text text-[13.5px] leading-[1.65] text-jj-gray-04">
              {placeholder}
            </div>
          )}
          <div
            ref={editor}
            role="textbox"
            aria-multiline="true"
            aria-label="Message body"
            aria-invalid={invalid || undefined}
            contentEditable={!readOnly}
            aria-readonly={readOnly || undefined}
            suppressContentEditableWarning
            spellCheck
            onFocus={rich.prime}
            onInput={rich.emit}
            onBlur={rich.emit}
            onKeyDown={(e) => { onShortcut(e); if (!e.defaultPrevented) rich.onKeyDown(e); }}
            onKeyUp={rich.refreshActive}
            onMouseUp={rich.refreshActive}
            onPaste={rich.onPaste}
            onDrop={rich.onDrop}
            style={{ minHeight, '--cc-rte-accent': accent }}
            className="cc-rte relative block w-full max-h-[min(62vh,640px)] overflow-y-auto resize-y px-3.5 py-3
                       outline-none bg-transparent font-johnson-text text-[13.5px] leading-[1.65] text-jj-gray-08"
          />
        </div>
      ) : (
        <textarea
          ref={area}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onMarkupKeyDown}
          readOnly={readOnly}
          rows={rows}
          placeholder={placeholder}
          aria-label="Message body (Markdown)"
          aria-invalid={invalid || undefined}
          style={{ minHeight }}
          className="block w-full px-3.5 py-3 border-0 outline-none resize-y bg-white font-mono
                     text-[12.5px] leading-[1.7] text-jj-gray-08 placeholder:text-jj-gray-04 placeholder:font-johnson-text"
        />
      )}

      {linkPrompt && (
        <PromptModal
          title="Add a link"
          subtitle={linkPrompt.text ? `Links “${linkPrompt.text.slice(0, 60)}”` : 'Inserted where the cursor is'}
          label="Web or email address"
          placeholder="https://"
          confirmLabel="Add link"
          validate={linkError}
          onCancel={() => {
            setLinkPrompt(null);
            requestAnimationFrame(() => (mode === 'rich' ? editor.current : area.current)?.focus());
          }}
          onConfirm={applyLink}
        />
      )}
    </div>
  );
};

/* ─── Directory picker ────────────────────────────────────────────────────── */

const SEARCH_LIMIT = 25;      // the picker's list
const SUGGEST_LIMIT = 8;      // the dropdown under a recipient box
const MIN_SEARCH = 2;
const SUGGEST_DEBOUNCE = 220;

const initials = (name, email) => {
  const source = (name || email || '?').replace(/[^A-Za-z, ]/g, ' ').trim();
  const parts = source.split(/[\s,]+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
};

// A steady colour per address, so the same person always looks the same.
const CHIP_COLORS = ['#eb1700', '#0f68b2', '#8c3bbb', '#328714', '#ff6017', '#9e0000', '#004685', '#541980'];
const chipColor = (addr) => CHIP_COLORS[
  [...String(addr).toLowerCase()].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % CHIP_COLORS.length];

const NONE = 'NONE';
const NAME_KEY = (email) => `dir_name_${email}`;

const rememberSession = (key, value) => {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* quota or blocked storage - state still has it for this session */
  }
};

function useDirectoryNames(emails) {
  const { instance, accounts } = useMsal();
  const [names, setNames] = useState({});
  const asked = useRef(new Set());

  // A sorted, de-duplicated string so the effect re-runs when the set of
  // people changes and not merely when the array is rebuilt.
  const key = [...new Set(emails.filter(Boolean).map((e) => e.toLowerCase()))]
    .sort().join('|');

  useEffect(() => {
    const wanted = key ? key.split('|') : [];
    if (!wanted.length || !accounts.length) return undefined;

    const cached = {};
    const todo = [];
    wanted.forEach((email) => {
      if (asked.current.has(email)) return;
      let hit = null;
      try {
        hit = sessionStorage.getItem(NAME_KEY(email));
      } catch {
        /* blocked storage - just fetch it */
      }
      if (!hit) {
        todo.push(email);
        return;
      }
      asked.current.add(email);
      if (hit === NONE) return;
      try {
        cached[email] = JSON.parse(hit);
      } catch {
        todo.push(email);
      }
    });
    if (Object.keys(cached).length) setNames((prev) => ({ ...prev, ...cached }));
    if (!todo.length) return undefined;

    let cancelled = false;

    (async () => {
      let token;
      try {
        const auth = await instance.acquireTokenSilent({
          scopes: ['User.Read.All'],
          account: accounts[0],
        });
        token = auth?.accessToken;
      } catch {
        return; // names are decoration - never prompt for them
      }
      if (!token || cancelled) return;

      todo.forEach((email) => asked.current.add(email));

      // Small batches, so a role with thirty people on it does not fire thirty
      // requests at once and get throttled for its trouble.
      for (let i = 0; i < todo.length && !cancelled; i += 5) {
        const batch = todo.slice(i, i + 5);
        const found = {};
        await Promise.all(batch.map(async (email) => {
          try {
            const res = await fetch(
              `${GRAPH}/users/${encodeURIComponent(email)}?$select=displayName,jobTitle`,
              { headers: { Authorization: `Bearer ${token}` } },
            );
            if (!res.ok) {
              // A 404 is ordinary here - a distribution list or a leaver.
              rememberSession(NAME_KEY(email), NONE);
              return;
            }
            const user = await res.json();
            const entry = {
              name: cleanName(user.displayName),
              title: user.jobTitle || '',
            };
            if (!entry.name) {
              rememberSession(NAME_KEY(email), NONE);
              return;
            }
            rememberSession(NAME_KEY(email), JSON.stringify(entry));
            found[email] = entry;
          } catch {
            /* leave the address showing */
          }
        }));
        if (cancelled) return;
        if (Object.keys(found).length) setNames((prev) => ({ ...prev, ...found }));
      }
    })();

    return () => { cancelled = true; };
  }, [key, accounts.length, instance]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed on stable primitives; MSAL hands back a new accounts array on every auth event

  return (email) => names[String(email || '').toLowerCase()] || null;
}


/** Photo (or initials) beside a name and one line under it. */
const PersonIdentity = ({ person, photo, detail }) => (
  <>
    {photo ? (
      <img src={photo} alt="" className="w-7 h-7 rounded-full object-cover flex-none" />
    ) : (
      <span className="w-7 h-7 rounded-full flex-none bg-jj-gray-02 flex items-center justify-center
                       font-johnson-text text-[10.5px] text-jj-gray-07">
        {initials(person.name, person.email)}
      </span>
    )}
    <span className="flex-1 min-w-0">
      <span className="block font-johnson-text text-[13px] text-jj-gray-08 truncate">
        {person.name || person.email}
      </span>
      <span className="block font-johnson-text text-[11.5px] text-jj-gray-05 truncate">{detail}</span>
    </span>
  </>
);

const PersonRow = ({ person, photo, checked, onToggle }) => (
  <label
    className={`flex items-center gap-2.5 px-2.5 py-2 rounded-[9px] cursor-pointer border
                ${checked ? 'bg-jj-red/[0.04] border-jj-red/20' : 'border-transparent hover:bg-jj-gray-01'}`}
  >
    <input
      type="checkbox"
      checked={checked}
      onChange={onToggle}
      className="w-3.5 h-3.5 flex-none accent-[#eb1700]"
    />
    <PersonIdentity person={person} photo={photo} detail={person.name ? person.email : person.title || ''} />
  </label>
);

/* ─── Recipient field (chips over the raw string, with AD suggestions) ─────── */

/**
 * The To/Cc/Bcc box.
 *
 * Still chips over the raw comma-separated string the backend parses - the
 * suggestions are a way of typing, not a second source of truth, and anything
 * typed by hand and never matched still goes through exactly as before.
 *
 * Behaves the way the same box does in Outlook: type two characters, pick from
 * the directory with the arrow keys or the mouse, Enter takes the highlighted
 * one. Enter with nothing highlighted still commits what was typed, so an
 * address that is not in the directory - a distribution list, a contractor -
 * is no harder to enter than it was.
 */
export const RecipientField = ({
  label, value, onChange, placeholder, onDraftChange,
}) => {
  const { instance, accounts } = useMsal();
  const [draft, setDraft] = useState('');
  // `for` is the query these results answer. Without it there is no way to
  // tell whether what is on screen still belongs to what is in the box.
  const [suggest, setSuggest] = useState(
    { loading: false, error: '', results: [], for: '' });
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // Whether the admin has actually moved onto a suggestion, as opposed to
  // one merely sitting there at the top of the list.
  const [navigated, setNavigated] = useState(false);
  // Every lookup takes a ticket. A slow reply for "sa" must not land on top of
  // a fast one for "sabapathy" and put the wrong names under the cursor.
  const ticket = useRef(0);
  const listId = useId();

  const parsed = useMemo(() => splitAddresses(value), [value]);
  const hasInvalid = parsed.some((a) => !ADDR_RE.test(a));
  const taken = useMemo(
    () => new Set(parsed.map((a) => a.toLowerCase())), [parsed]);

  const query = draft.trim();
  const looking = query.length >= MIN_SEARCH;

  useEffect(() => {
    if (!looking || !accounts.length) {
      setSuggest({ loading: false, error: '', results: [], for: '' });
      return undefined;
    }
    const mine = ticket.current + 1;
    ticket.current = mine;
    setSuggest((current) => ({ ...current, loading: true, error: '' }));

    const timer = setTimeout(async () => {
      try {
        const results = await searchDirectory(
          await graphToken(instance, accounts), query, SUGGEST_LIMIT);
        if (mine !== ticket.current) return;
        setSuggest({ loading: false, error: '', results, for: query });
        setHighlight(0);
      } catch (err) {
        if (mine !== ticket.current) return;
        setSuggest({
          loading: false, error: err.message || 'Lookup failed', results: [], for: query });
      }
    }, SUGGEST_DEBOUNCE);

    return () => clearTimeout(timer);
  }, [query, looking, instance, accounts.length]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed on stable primitives; MSAL hands back a new accounts array on every auth event

  // Somebody already on the list is not a suggestion.
  const shown = useMemo(
    () => suggest.results.filter((person) => !taken.has(person.email.toLowerCase())),
    [suggest.results, taken]);

  const listVisible = open && looking;
  // Do these suggestions answer what is in the box right now? While they do
  // not, they stay on screen so the list does not flicker on every
  // keystroke - but nothing can be taken from them.
  const fresh = !suggest.loading && suggest.for === query;
  const photoFor = useDirectoryPhotos(listVisible ? shown : []);

  const commit = () => {
    const next = splitAddresses(draft);
    if (!next.length) return;
    onChange([...parsed, ...next].join(', '));
    setDraft('');
  };

  const accept = (person) => {
    onChange([...parsed, person.email].join(', '));
    setDraft('');
    setOpen(false);
    setNavigated(false);
    setSuggest({ loading: false, error: '', results: [], for: '' });
  };

  const removeAt = (index) =>
    onChange(parsed.filter((_, i) => i !== index).join(', '));

  const report = useRef(onDraftChange);
  report.current = onDraftChange;
  useEffect(() => { report.current?.(draft); }, [draft]);

  const onKeyDown = (e) => {
    const picking = listVisible && fresh && shown.length > 0;

    if (picking && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setNavigated(true);
      setHighlight((current) => {
        const step = e.key === 'ArrowDown' ? 1 : -1;
        return (current + step + shown.length) % shown.length;
      });
      return;
    }

    if (picking && (navigated || !ADDR_RE.test(query))
        && (e.key === 'Enter' || e.key === 'Tab')) {
      const person = shown[Math.min(highlight, shown.length - 1)];
      if (person) {
        // Tab still moves focus along; Enter must not reach anything else.
        if (e.key === 'Enter') e.preventDefault();
        accept(person);
        return;
      }
    }
    if (listVisible && e.key === 'Escape') {
      // Kept off the window listener, or this would close the send dialog too.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      return;
    }

    if (['Enter', ',', ';'].includes(e.key) && draft.trim()) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Tab' && draft.trim()) {
      // Commit what was typed but let focus move on - preventing default here
      // left keyboard users unable to tab out of the field.
      commit();
    } else if (e.key === 'Backspace' && !draft && parsed.length) {
      onChange(parsed.slice(0, -1).join(', '));
    }
  };

  return (
    <div className="flex items-start gap-2.5 py-1 border-b border-dashed border-jj-gray-02 last:border-b-0">
      <label className="w-8 flex-none pt-[11px] font-johnson-text text-[12px] font-medium text-jj-gray-06">{label}</label>
      <div className="flex-1 min-w-0 relative">
        <div
          className={`flex flex-wrap items-center gap-1.5 min-h-[40px] py-1 transition-shadow ${
            hasInvalid ? 'shadow-[inset_0_-2px_0_rgba(235,23,0,0.55)]' : ''}`}
        >
          {parsed.map((addr, index) => {
            const ok = ADDR_RE.test(addr);
            return (
              <span
                key={`${addr}-${index}`}
                title={ok ? addr : `${addr} is not a valid address`}
                className={`cc-pop inline-flex items-center gap-1.5 pl-1 pr-1.5 py-1 rounded-full font-johnson-text text-[12px] max-w-full
                            transition-colors ${ok ? 'bg-jj-gray-01 text-jj-gray-08 hover:bg-jj-gray-02'
                                 : 'bg-jj-red/[0.08] text-jj-maroon-05 shadow-[inset_0_0_0_1px_rgba(235,23,0,0.25)]'}`}
              >
                <span
                  aria-hidden="true"
                  className="w-[22px] h-[22px] rounded-full flex items-center justify-center flex-none text-white
                             font-johnson-display font-bold text-[9.5px]"
                  style={{ background: ok ? chipColor(addr) : '#9e0000' }}
                >
                  {ok ? initials('', addr.split('@')[0].replace(/[._-]+/g, ' ')) : '!'}
                </span>
                <span className="truncate max-w-[230px]">{addr}</span>
                <button
                  type="button"
                  onClick={() => removeAt(index)}
                  aria-label={`Remove ${addr}`}
                  className="w-4 h-4 rounded-full flex items-center justify-center opacity-60 hover:opacity-100 hover:bg-white"
                >
                  <Icon src={closeIcon} className="w-2 h-2" tone="gray" />
                </button>
              </span>
            );
          })}
          <input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setOpen(true);
              setNavigated(false);   // a new query - nothing chosen in it yet
            }}
            onKeyDown={onKeyDown}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            placeholder={parsed.length ? '' : placeholder}
            role="combobox"
            aria-expanded={listVisible}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              listVisible && shown.length ? `${listId}-${highlight}` : undefined}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            name={`recipients-${listId}`}
            className="flex-1 min-w-[160px] border-0 outline-none bg-transparent px-0.5 py-1.5
                       font-johnson-text text-[13px] text-jj-gray-08 placeholder:text-jj-gray-05"
          />
        </div>

        {listVisible && (
          <div
            id={listId}
            role="listbox"
            // mousedown, not click: the input would blur first and the list
            // would be gone before the click ever landed on a row.
            onMouseDown={(e) => e.preventDefault()}
            className="absolute left-0 right-0 top-full mt-1 z-40 bg-white rounded-xl
                       border border-jj-gray-02 shadow-[0_12px_32px_rgba(49,44,42,0.16)]
                       overflow-hidden"
          >
            {/* Inline, like the modal's cap: the one rule that keeps this
                list from running off the card should not depend on a
                utility class being generated. */}
            <div
              className={`overflow-auto py-1 ${
                fresh ? '' : 'opacity-50'}`}
              style={{ maxHeight: 264 }}
            >
              {suggest.loading && shown.length === 0 && (
                <p className={`${CLS.hint} px-3 py-2`}>Searching the directory…</p>
              )}
              {!suggest.loading && suggest.error && (
                <p className="px-3 py-2 font-johnson-text text-[11.5px] text-jj-maroon-05">
                  {suggest.error}
                </p>
              )}
              {fresh && !suggest.error && shown.length === 0 && (
                <p className={`${CLS.hint} px-3 py-2`}>
                  Nobody in the directory starts with “{query}”.
                  {ADDR_RE.test(query) && ' Press Enter to use it anyway.'}
                </p>
              )}
              {shown.map((person, index) => (
                <button
                  key={person.id || person.email}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === highlight}
                  onMouseEnter={() => setHighlight(index)}
                  // Guarded here, not by the dimming class above. A stale row
                  // adding the wrong address is a data problem, and a data
                  // problem must not be prevented by a stylesheet.
                  disabled={!fresh}
                  onClick={() => { if (fresh) accept(person); }}
                  className={`flex items-center gap-2.5 w-full text-left px-3 py-2 ${
                    index === highlight ? 'bg-jj-red/[0.05]' : 'hover:bg-jj-gray-01'
                  }`}
                >
                  <PersonIdentity
                    person={person}
                    photo={photoFor(person)}
                    detail={`${person.email}${person.title ? ` · ${person.title}` : ''}`}
                  />
                </button>
              ))}
            </div>
            {shown.length > 0 && (
              <div className="px-3 py-1.5 bg-[#f7f6f4] border-t border-jj-gray-01">
                <span className={CLS.hint}>
                  {fresh
                    ? '↑↓ to choose · Enter to add'
                    : 'Still looking · Enter adds what you typed'}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * Pick recipients out of the directory instead of typing them.
 *
 * Three kinds of source, all of them things the portal already knows:
 *   • the AD groups that grant a role, expanded through the same hook the
 *     sponsor lists use, so a group looked up once is cached for the session
 *   • anyone given a role directly in User Management — those are emails in
 *     the RBAC tables, not a group, so there is nobody to expand
 *   • a name search against the directory, for the one person who is in
 *     neither
 *
 * Whatever is ticked is handed back as plain addresses. The page still keeps
 * recipients as the raw string the backend parses, so this is a way of typing,
 * not a second source of truth.
 */
export const RecipientPicker = ({ onClose, onAdd, allowedDomains = [] }) => {
  const { AD_GROUP_ROLES, getAllRoles, getAllUserRoles, customRoles } = useRBAC();
  const { groups, load } = useAdGroupMembers();
  const { instance, accounts } = useMsal();

  const [picked, setPicked] = useState([]);
  const [term, setTerm] = useState('');
  const [people, setPeople] = useState({ loading: false, error: '', results: [] });

  // getAllRoles()/getAllUserOverrides() are rebuilt on every RBAC render, so
  // they are called inside rather than listed as dependencies; the overrides
  // are keyed on their contents instead.
  const overrides = getAllUserRoles() || {};
  const overridesKey = JSON.stringify(overrides);

  const sources = useMemo(() => {
    const roles = getAllRoles() || {};
    const out = Object.entries(AD_GROUP_ROLES || {}).map(([group, roleId]) => ({
      kind: 'group',
      id: `g:${group}`,
      group,
      name: group,
      note: roles[roleId]?.name || roleId,
      color: roles[roleId]?.color || '#a39992',
    }));

    const byRole = {};
    // Someone given several roles is listed under each of them
    Object.entries(JSON.parse(overridesKey)).forEach(([email, entry]) => {
      (entry?.roles || []).forEach((roleId) => {
        if (!byRole[roleId]) byRole[roleId] = [];
        byRole[roleId].push(email);
      });
    });
    Object.entries(byRole).forEach(([roleId, emails]) => {
      out.push({
        kind: 'role',
        id: `r:${roleId}`,
        name: roles[roleId]?.name || roleId,
        note: `${emails.length} assigned directly`,
        color: roles[roleId]?.color || '#a39992',
        people: emails.slice().sort().map((email) => ({ email, name: '', title: '' })),
      });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [AD_GROUP_ROLES, overridesKey, customRoles]);

  const [activeId, setActiveId] = useState(() => sources[0]?.id || 'search');
  const active = sources.find((s) => s.id === activeId) || null;
  const activeGroup = active?.kind === 'group' ? active.group : '';

  useEffect(() => {
    if (activeGroup) load(activeGroup);
  }, [activeGroup, load]);

  const token = useCallback(
    () => graphToken(instance, accounts), [instance, accounts]);

  // Debounced so a name typed at speed is one search, not nine.
  useEffect(() => {
    if (activeId !== 'search') return undefined;
    const query = term.trim();
    if (query.length < 2) {
      setPeople({ loading: false, error: '', results: [] });
      return undefined;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setPeople({ loading: true, error: '', results: [] });
      try {
        const results = await searchDirectory(await token(), query, SEARCH_LIMIT);
        if (cancelled) return;
        setPeople({ loading: false, error: '', results });
      } catch (err) {
        if (!cancelled) setPeople({ loading: false, error: err.message, results: [] });
      }
    }, 400);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [activeId, term, token]);

  /* What the right-hand list is showing, whichever source is selected. */
  const listing = useMemo(() => {
    if (activeId === 'search') {
      return { loading: people.loading, error: people.error, people: people.results };
    }
    if (active?.kind === 'role') return { people: active.people };
    const state = groups[activeGroup] || {};
    return {
      loading: state.loading,
      error: state.error,
      people: (state.members || []).filter((m) => m.isUser !== false && m.email),
    };
  }, [activeId, active, activeGroup, groups, people]);

  const shown = listing.people || [];

  // Faces for the people the group hook does not cover. Group members already
  // get theirs through useAdGroupMembers, so handing those over as well would
  // just fetch every one of them twice; search results and role entries arrive
  // with nothing but an address, and this resolves them straight off it.
  const photoFor = useDirectoryPhotos(active?.kind === 'group' ? [] : shown);

  // Only the role source needs this - a group member and a search hit both
  // arrive with a name already on them.
  const nameFor = useDirectoryNames(
    active?.kind === 'role' ? shown.map((person) => person.email) : []);

  const offDomain = allowedDomains.length
    ? picked.filter((email) => {
        const domain = email.split('@')[1]?.toLowerCase() || '';
        return !allowedDomains.some(
          (d) => domain === d.toLowerCase() || domain.endsWith(`.${d.toLowerCase()}`));
      })
    : [];

  const toggle = (email) =>
    setPicked((current) =>
      current.includes(email) ? current.filter((e) => e !== email) : [...current, email]);

  const addAllShown = () =>
    setPicked((current) => {
      const merged = [...current];
      shown.forEach((p) => { if (p.email && !merged.includes(p.email)) merged.push(p.email); });
      return merged;
    });

  const hand = (field) => {
    if (!picked.length) return;
    onAdd(field, picked);
    onClose();
  };

  return (
    <Modal
      title="Add from the directory"
      subtitle="Pick a group, a role, or search for someone. Everything ticked is added as an address you can still edit."
      width={760}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto font-johnson-text text-[12px] text-jj-gray-06 self-center">
            {picked.length
              ? `${picked.length} selected${offDomain.length ? ` · ${offDomain.length} outside the allowed domains` : ''}`
              : 'Nothing selected yet'}
          </span>
          <button onClick={onClose} className={CLS.ghostBtn}>Cancel</button>
          {['To', 'Cc', 'Bcc'].map((field) => (
            <button
              key={field}
              onClick={() => hand(field.toLowerCase())}
              disabled={!picked.length}
              className={field === 'To' ? CLS.primaryBtn : CLS.ghostBtn}
            >
              Add to {field}
            </button>
          ))}
        </>
      }
    >
      {/* A real height, not a minimum. Both columns are scroll containers, and
          a scroll container whose parent is free to grow does not scroll - it
          grows, and takes the modal off the top and bottom of the screen with
          it once a search returns a couple of dozen people. */}
      <div className="flex gap-4" style={{ height: 'min(58vh, 460px)' }}>
        {/* sources */}
        <div className="w-[230px] flex-none flex flex-col gap-0.5 overflow-auto pr-0.5">
          <div className={`${CLS.railH} mb-1.5`}>Groups and roles</div>
          {sources.length === 0 && (
            <p className={`${CLS.hint} mb-2`}>
              No AD groups are mapped in this environment.
            </p>
          )}
          {sources.map((source) => (
            <button
              key={source.id}
              onClick={() => setActiveId(source.id)}
              className={`flex items-center gap-2.5 w-full text-left px-2.5 py-2 rounded-[9px]
                          border transition-colors ${
                activeId === source.id
                  ? 'bg-jj-red/[0.04] border-jj-red/20'
                  : 'border-transparent hover:bg-jj-gray-01'
              }`}
              style={{ borderLeft: `3px solid ${activeId === source.id ? source.color : 'transparent'}` }}
            >
              <Icon
                src={source.kind === 'group' ? communityIcon : personIcon}
                className="w-3.5 h-3.5 flex-none opacity-70"
              />
              <span className="flex-1 min-w-0">
                <span className="block font-johnson-text text-[12.5px] text-jj-gray-08 truncate">
                  {source.name}
                </span>
                <span className="block font-johnson-text text-[11px] text-jj-gray-05 truncate">
                  {source.note}
                </span>
              </span>
            </button>
          ))}

          <button
            onClick={() => setActiveId('search')}
            className={`flex items-center gap-2.5 w-full text-left px-2.5 py-2 mt-1.5 rounded-[9px]
                        border transition-colors ${
              activeId === 'search'
                ? 'bg-jj-red/[0.04] border-jj-red/20 border-l-[3px] border-l-jj-red'
                : 'border-transparent hover:bg-jj-gray-01'
            }`}
          >
            <Icon src={searchIcon} className="w-3.5 h-3.5 flex-none" tone="gray" />
            <span className="font-johnson-text text-[12.5px] text-jj-gray-08">
              Search the directory
            </span>
          </button>
        </div>

        {/* members */}
        <div className="flex-1 min-w-0 flex flex-col">
          {activeId === 'search' ? (
            <div className="relative mb-2.5">
              <Icon src={searchIcon} className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2" tone="gray" />
              <input
                autoFocus
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="Name or email (at least two characters)"
                className={`${CLS.input} pl-8`}
              />
            </div>
          ) : (
            <div className="flex items-center justify-between mb-2.5">
              <span className="font-johnson-text text-[12.5px] text-jj-gray-06">
                {shown.length
                  ? `${shown.length} member${shown.length === 1 ? '' : 's'}`
                  : ''}
              </span>
              <button onClick={addAllShown} disabled={!shown.length} className={CLS.chipBtn}>
                Select all
              </button>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-auto flex flex-col gap-0.5 pr-0.5">
            {listing.loading && (
              <p className={`${CLS.hint} p-4 text-center`}>Looking that up…</p>
            )}
            {!listing.loading && listing.error && (
              <p className="p-4 text-center font-johnson-text text-[12.5px] text-jj-maroon-05">
                {listing.error}
              </p>
            )}
            {!listing.loading && !listing.error && shown.length === 0 && (
              <p className={`${CLS.hint} p-4 text-center`}>
                {activeId === 'search'
                  ? 'Type a name or an address to search.'
                  : 'Nobody in this one.'}
              </p>
            )}
            {shown.map((person) => {
              const resolved = person.name ? null : nameFor(person.email);
              return (
                <PersonRow
                  key={person.id || person.email}
                  person={resolved ? { ...person, ...resolved } : person}
                  photo={person.photo || photoFor(person)}
                  checked={picked.includes(person.email)}
                  onToggle={() => toggle(person.email)}
                />
              );
            })}
            {activeId === 'search' && shown.length >= SEARCH_LIMIT && (
              <p className={`${CLS.hint} px-2.5 py-2`}>
                First {SEARCH_LIMIT} matches. Keep typing to narrow it down.
              </p>
            )}
          </div>

          {picked.length > 0 && (
            <div
              className="flex-none mt-2.5 pt-2.5 border-t border-jj-gray-01
                         flex flex-wrap gap-1.5 overflow-auto"
              style={{ maxHeight: 86 }}
            >
              {picked.map((email) => (
                <span
                  key={email}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-jj-gray-01
                             border border-jj-gray-02 font-johnson-text text-[11.5px] text-jj-gray-08"
                >
                  <span className="truncate max-w-[200px]">{email}</span>
                  <button onClick={() => toggle(email)} aria-label={`Remove ${email}`}
                          className="opacity-50 hover:opacity-100 flex">
                    <Icon src={closeIcon} className="w-2.5 h-2.5" tone="gray" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};