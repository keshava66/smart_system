import React, { useEffect, useRef, useState } from 'react';

// Collapsible "Search fields" block for the filter rail. Starts closed (open if a
// search is already filled in) so the text boxes don't push the facets off
// screen. Inputs stay mounted while closed, so typed values are kept.
export default function SearchSection({ children, label = 'Search fields', hint = 'Type in any box to find records where that field contains your text. Boxes combine, so every filled box has to match. Results update a moment after you stop typing.' }) {
  const bodyRef = useRef(null);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  // Inputs are controlled by the parent, so any change to them arrives as new
  // children; recount the filled boxes then.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setActive([...el.querySelectorAll('input')].filter(i => i.value.trim()).length);
  }, [children]);
  // Opens by itself once if it mounts with a search already typed in (e.g. the
  // filter rail was collapsed and reopened). The count above lands after the
  // first render, so this has to follow it rather than run once on mount.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (active > 0 && !autoOpened.current) { autoOpened.current = true; setOpen(true); }
  }, [active]);
  return (
    <div className="border-b border-jj-gray-01 flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        title={hint}
        className="w-full flex items-center justify-between px-[18px] py-3.5 text-left hover:bg-jj-gray-01/50 transition-colors"
      >
        <span className="flex items-center gap-2 text-[11px] font-johnson-text font-bold uppercase tracking-wider text-jj-gray-07">
          <svg viewBox="0 0 16 16" className="w-[13px] h-[13px] flex-shrink-0 text-jj-gray-06" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="m10.4 10.4 3.4 3.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          {label}
          {active > 0 && (
            <span className="inline-flex items-center justify-center min-w-[17px] h-[17px] px-1 rounded-full bg-jj-red text-white text-[10px] font-medium normal-case tracking-normal">
              {active}
            </span>
          )}
        </span>
        <svg viewBox="0 0 10 10" className={`w-2.5 h-2.5 flex-shrink-0 text-jj-gray-06 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true">
          <path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div ref={bodyRef} className={open ? 'px-[18px] pb-3.5 space-y-2 max-h-[45vh] overflow-y-auto' : 'hidden'}>
        {children}
      </div>
    </div>
  );
}
