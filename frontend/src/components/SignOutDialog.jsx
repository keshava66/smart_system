import { useEffect, useRef, useState } from "react";

// Asks before signing out. Cancel is focused first so a stray Enter doesn't end the session.
export default function SignOutDialog({ open, onClose, onConfirm }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { setBusy(false); d.showModal?.(); }
    if (!open && d.open) d.close();
  }, [open]);

  const confirm = async () => {
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current && !busy) onClose(); }}
      aria-labelledby="signout-title"
      aria-describedby="signout-desc"
      className="w-[min(380px,calc(100vw-2rem))] p-0 rounded-2xl border border-jj-gray-02 shadow-2xl backdrop:bg-jj-gray-08/40"
    >
      <div className="px-6 pt-5 pb-4">
        <h2 id="signout-title" className="font-johnson-display text-base text-jj-gray-08">Sign out of SmartHub?</h2>
        <p id="signout-desc" className="mt-1.5 font-johnson-text text-sm text-jj-gray-07">
          Anything you haven&apos;t saved will be lost. You&apos;ll need to sign in again to come back.
        </p>
      </div>
      <div className="flex justify-end gap-2 px-6 pb-5">
        <button type="button" autoFocus onClick={onClose} disabled={busy}
          className="h-9 px-4 rounded-lg border border-jj-gray-02 font-johnson-text text-sm text-jj-gray-08 hover:bg-jj-gray-01 disabled:opacity-60">
          Cancel
        </button>
        <button type="button" onClick={confirm} disabled={busy}
          className="h-9 px-4 rounded-lg bg-jj-red font-johnson-text text-sm text-white hover:bg-[#d41500] disabled:opacity-60">
          {busy ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </dialog>
  );
}
