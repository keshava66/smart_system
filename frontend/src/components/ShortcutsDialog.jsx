import { useEffect, useRef } from "react";

const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "") ? "⌘" : "Ctrl";

// Only keys the portal actually listens for; keep in step with the handlers
// in Dashboard.jsx, Sidebar.jsx and BusinessDefinedChecks.jsx.
const SHORTCUTS = [
  [[mod, "K"], "Search tools on the dashboard, or rules on Business Defined Checks"],
  [["/"], "Jump to the search box"],
  [["["], "Collapse or expand the sidebar"],
  [["1", "–", "9"], "Switch tabs on Business Defined Checks"],
  [["Esc"], "Close a menu, dialog or panel"],
];

export default function ShortcutsDialog({ open, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      aria-labelledby="shortcuts-title"
      className="w-[min(440px,calc(100vw-2rem))] p-0 rounded-2xl border border-jj-gray-02 shadow-2xl backdrop:bg-jj-gray-08/40"
    >
      <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-jj-gray-02">
        <h2 id="shortcuts-title" className="font-johnson-display text-base text-jj-gray-08">Keyboard shortcuts</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="w-8 h-8 rounded-lg text-jj-gray-07 hover:bg-jj-gray-01">✕</button>
      </div>
      <ul className="px-5 py-3">
        {SHORTCUTS.map(([keys, what]) => (
          <li key={what} className="flex items-center justify-between gap-4 py-2 font-johnson-text text-sm text-jj-gray-07">
            <span>{what}</span>
            <span className="flex items-center gap-1 flex-shrink-0">
              {keys.map((k) => (k === "–"
                ? <span key={k} className="text-jj-gray-05">–</span>
                : <kbd key={k} className="min-w-6 text-center font-johnson-text text-xs text-jj-gray-08 bg-jj-gray-01 border border-jj-gray-02 rounded px-1.5 py-0.5">{k}</kbd>))}
            </span>
          </li>
        ))}
      </ul>
    </dialog>
  );
}
