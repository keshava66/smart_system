import { useEffect, useSyncExternalStore } from 'react';
import { apiFetch } from './apiClient';

/*
 * The portal's one motion setting. People choose it in the account menu; it
 * governs every animation and transition in the portal. The operating
 * system's "reduce motion" setting is ignored on purpose: Windows Cloud PCs
 * report it by default, which would freeze the portal for everyone on one.
 *
 * On: <html> carries the "reduce-motion" class. CSS targets that class
 * (html.reduce-motion ...); scripts read reducedMotion() or useReducedMotion().
 * Tailwind's motion variants and the CSS media query follow the OS, so the
 * portal doesn't use them (a release test checks).
 *
 * The browser keeps a copy so the page starts in the right mode; the server
 * copy follows the person to other machines.
 */

const KEY = 'smarthub.reduceMotion';
const LEGACY_KEY = 'regwiz-reduce-motion'; // the assistant panel's old switch
const listeners = new Set();

function readSaved() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved != null) return saved === 'true';
    return localStorage.getItem(LEGACY_KEY) === '1';
  } catch {
    return false;
  }
}

let current = readSaved();

function apply() {
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('reduce-motion', current);
}
apply();

export function reducedMotion() {
  return current;
}

export function subscribeReducedMotion(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Change the setting on this device (no server call). */
export function setReducedMotion(on) {
  const next = Boolean(on);
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(KEY, String(next));
    localStorage.removeItem(LEGACY_KEY);
  } catch { /* storage blocked: the setting still holds for this visit */ }
  apply();
  listeners.forEach((fn) => {
    try { fn(next); } catch { /* one bad listener must not block the rest */ }
  });
}

/** Change the setting and save it to the person's account. */
export async function saveReducedMotion(on) {
  setReducedMotion(on);
  try {
    await apiFetch('/api/audit/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reduce_motion: Boolean(on) }),
    });
  } catch { /* offline: this device already has it; the server catches up next change */ }
}

export function useReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, reducedMotion, () => false);
}

/** Once per signed-in person: take the setting saved on their account. */
export function useSyncedMotionPreference(userEmail) {
  useEffect(() => {
    if (!userEmail) return undefined;
    let live = true;
    apiFetch('/api/audit/preferences')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        const saved = body?.preferences?.reduce_motion;
        if (live && typeof saved === 'boolean') setReducedMotion(saved);
      })
      .catch(() => { /* offline: keep this device's copy */ });
    return () => { live = false; };
  }, [userEmail]);
}
