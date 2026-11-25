import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronDown, ChevronRight, Copy, Keyboard, LogOut, Megaphone, ShieldCheck, Sparkles, Waves } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useRBAC } from "../context/RBACContext";
import { useAssistantSettings } from "../context/AssistantSettingsContext";
import { useProfilePhoto } from "../hooks/useProfilePhoto";
import { NARROW, useMediaQuery } from "../hooks/useMediaQuery";
import { PALETTE_EVENT } from "../utils/events";
import { saveReducedMotion, useReducedMotion } from "../utils/motion";
import { firstLast } from "../utils/displayName";
import MenuButton from "./MenuButton";
import ShortcutsDialog from "./ShortcutsDialog";
import SignOutDialog from "./SignOutDialog";
import searchIcon  from "/icons/JJ_Icon_Search_RGB.svg";
import jjLogo      from "/jj-logo.png";
import collapseIcon from "/icons/JJ_Icon_Chevron_Left.svg";
import expandIcon   from "/icons/JJ_Icon_Chevron_Right.svg";

// ------------------------------------------------------------ menu behaviour

const ITEM_SELECTOR = '[role="menuitem"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled])';

const NAV_KEYS = {
  ArrowDown: (index, count) => (index + 1) % count,
  ArrowUp: (index, count) => (index <= 0 ? count - 1 : index - 1),
  Home: () => 0,
  End: (_index, count) => count - 1,
};

const OPEN_KEYS = { ArrowDown: 'first', ArrowUp: 'last' };

const menuItems = (menu) => (menu ? [...menu.querySelectorAll(ITEM_SELECTOR)] : []);

const focusItemAt = (menu, pickIndex) => {
  const items = menuItems(menu);
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement);
  items[pickIndex(current, items.length)].focus();
};

const OPEN_FOCUS = { first: NAV_KEYS.Home, last: NAV_KEYS.End };

// Keyboard opens land on an item; pointer opens focus the panel so arrows still work.
const focusOnOpen = (menu, target) => {
  const pickIndex = OPEN_FOCUS[target];
  if (pickIndex) focusItemAt(menu, pickIndex);
  else menu.focus({ preventScroll: true });
};

/*
 * Menu button behaviour (WAI-ARIA APG): opening from the keyboard lands on
 * the first item, arrows/Home/End move between items, Escape and Tab close
 * and hand focus back to the button, a press outside the container closes.
 */
const useMenu = () => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const containerRef = useRef(null);
  const openFocus = useRef(null);

  const close = useCallback(() => setOpen(false), []);

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // A click fired by Enter or Space has detail 0: treat it as a keyboard open.
  const toggle = useCallback((event) => {
    openFocus.current = event.detail === 0 ? 'first' : null;
    setOpen((wasOpen) => !wasOpen);
  }, []);

  const onTriggerKeyDown = useCallback((event) => {
    const target = OPEN_KEYS[event.key];
    if (!target) return;
    event.preventDefault();
    openFocus.current = target;
    setOpen(true);
  }, []);

  const onMenuKeyDown = useCallback((event) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      closeAndRestoreFocus();
      return;
    }
    const pickIndex = NAV_KEYS[event.key];
    if (!pickIndex) return;
    event.preventDefault();
    focusItemAt(menuRef.current, pickIndex);
  }, [closeAndRestoreFocus]);

  useEffect(() => {
    if (!open || !menuRef.current) return;
    focusOnOpen(menuRef.current, openFocus.current);
    openFocus.current = null;
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const dismissOutside = (event) => {
      if (!containerRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, [open]);

  return { open, close, toggle, triggerRef, menuRef, containerRef, onTriggerKeyDown, onMenuKeyDown };
};

// ------------------------------------------------------------ copy to clipboard

const RESET_AFTER_MS = 2000;

// Copies text to the clipboard and reports 'idle' | 'copied' | 'failed'.
// The clipboard API is missing outside secure contexts, which counts as a failure.
const useCopyText = () => {
  const [status, setStatus] = useState('idle');
  const resetTimer = useRef(undefined);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const copy = useCallback(async (text) => {
    clearTimeout(resetTimer.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(text);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
    resetTimer.current = setTimeout(() => setStatus('idle'), RESET_AFTER_MS);
  }, []);

  return { status, copy };
};

// ------------------------------------------------------------ account menu

// Joins class names, dropping falsy entries so conditions stay flat.
const cn = (...classes) => classes.filter(Boolean).join(' ');

// ---------------------------------------------------------------- avatar

const SIZE = {
  sm: 'size-8 text-xs',
  lg: 'size-12 text-base',
};

const initialsOf = (name) => {
  return firstLast(name)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
};

// Directory photo, or the person's initials when there is none or it fails to load.
const UserAvatar = ({ photo, loading, name, size = 'sm', className }) => {
  const [failedSrc, setFailedSrc] = useState(null);
  const handleError = useCallback(() => setFailedSrc(photo), [photo]);
  const base = cn('shrink-0 rounded-full', SIZE[size], className);

  if (loading) {
    return <span aria-hidden="true" className={cn(base, 'block animate-pulse bg-jj-gray-02')} />;
  }

  if (photo && failedSrc !== photo) {
    return (
      <img
        src={photo}
        alt=""
        onError={handleError}
        className={cn(base, 'object-cover outline outline-1 -outline-offset-1 outline-black/10')}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(base, 'grid place-items-center bg-jj-red/10 font-johnson-display font-bold text-jj-red')}
    >
      {initialsOf(name)}
    </span>
  );
};

// ---------------------------------------------------------------- menu rows

const ROW = cn(
  'group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left font-johnson-text outline-none',
  'transition-colors duration-150 hover:bg-jj-gray-01/70 focus-visible:bg-jj-gray-01/70',
  'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-jj-red/50',
);

const TILE_TONE = {
  default: 'bg-jj-gray-01 text-jj-gray-07 group-hover:bg-white group-hover:text-jj-gray-08 group-focus-visible:bg-white',
  active: 'bg-jj-red/10 text-jj-red',
};

const IconTile = ({ icon: Icon, tone }) => {
  return (
    <span
      aria-hidden="true"
      className={cn('grid size-8 shrink-0 place-items-center rounded-lg transition-colors duration-150', TILE_TONE[tone])}
    >
      <Icon className="size-4" strokeWidth={1.75} />
    </span>
  );
};

const RowText = ({ label, hint, hintId }) => {
  return (
    <span className="min-w-0 flex-1">
      <span className="block text-sm leading-5 text-jj-gray-08">{label}</span>
      {hint && <span id={hintId} className="block text-pretty text-xs leading-4 text-jj-gray-07">{hint}</span>}
    </span>
  );
};

const MenuAction = ({ icon, label, hint, onSelect, navigates = false }) => {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={ROW}
    >
      <IconTile icon={icon} tone="default" />
      <RowText label={label} hint={hint} />
      {navigates && (
        <ChevronRight
          aria-hidden="true"
          strokeWidth={1.75}
          className="size-4 shrink-0 text-jj-gray-05 transition-transform duration-150 group-hover:translate-x-0.5"
        />
      )}
    </button>
  );
};

const MenuToggle = ({ icon, label, hint, checked, onToggle }) => {
  const hintId = useId();
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={hintId}
      onClick={onToggle}
      className={ROW}
    >
      <IconTile icon={icon} tone={checked ? 'active' : 'default'} />
      <RowText label={label} hint={hint} hintId={hintId} />
      <span
        aria-hidden="true"
        className={cn(
          'flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200',
          checked ? 'bg-jj-red' : 'bg-jj-gray-03',
        )}
      >
        <span
          className={cn(
            'size-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-snappy',
            checked ? 'translate-x-4' : 'translate-x-0',
          )}
        />
      </span>
    </button>
  );
};

// Plain J&J red text and icon; the icon sits in the tile column so the label lines up with the rows above.
const SignOutButton = ({ onSelect }) => {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left font-johnson-text text-sm leading-5 text-jj-red outline-none',
        'transition-colors duration-150 hover:bg-jj-red/5 focus-visible:bg-jj-red/5',
        'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-jj-red/50',
      )}
    >
      <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center">
        <LogOut strokeWidth={1.75} className="size-[18px]" />
      </span>
      Sign out
    </button>
  );
};

const MenuSeparator = () => {
  return <div role="separator" className="mx-3 my-1 h-px bg-jj-gray-02" />;
};

// ---------------------------------------------------------------- identity card

const COPY_STATUS_TEXT = {
  idle: '',
  copied: 'Email address copied',
  failed: 'Copy is blocked here. The email is selected, press Ctrl+C to copy it.',
};

const ICON_SWAP = 'col-start-1 row-start-1 size-3.5 transition-[opacity,transform,filter] duration-300 ease-snappy';
const ICON_SHOWN = 'scale-100 opacity-100 blur-none';
const ICON_HIDDEN = 'scale-[0.25] opacity-0 blur-[4px]';

const selectContents = (element) => {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

const IdentityCard = ({ user, photo, photoLoading, role }) => {
  const emailRef = useRef(null);
  const { status, copy } = useCopyText();
  const copied = status === 'copied';

  const copyEmail = useCallback(() => copy(user.email), [copy, user.email]);

  // Without clipboard access, select the address so the person can copy it by hand.
  useEffect(() => {
    if (status === 'failed' && emailRef.current) selectContents(emailRef.current);
  }, [status]);

  return (
    <div className="flex items-start gap-3 rounded-xl bg-jj-gray-01 p-3">
      <UserAvatar photo={photo} loading={photoLoading} name={user.name} size="lg" className="ring-2 ring-white" />
      <div className="min-w-0 flex-1">
        <p className="text-balance break-words font-johnson-display text-[15px] leading-5 text-jj-gray-08">{user.name}</p>
        <div className="mt-0.5 flex min-w-0 items-center gap-1">
          <span ref={emailRef} title={user.email} className="min-w-0 select-text truncate font-johnson-text text-xs leading-6 text-jj-gray-07">
            {user.email}
          </span>
          <button
            type="button"
            role="menuitem"
            aria-label="Copy email address"
            onClick={copyEmail}
            className={cn(
              'relative grid size-6 shrink-0 place-items-center rounded-md outline-none transition-colors duration-150',
              'after:absolute after:left-1/2 after:top-1/2 after:size-9 after:-translate-x-1/2 after:-translate-y-1/2',
              'hover:bg-white focus-visible:bg-white focus-visible:ring-2 focus-visible:ring-jj-red/50',
              copied ? 'text-jj-green-03' : 'text-jj-gray-07 hover:text-jj-gray-08',
            )}
          >
            <Copy aria-hidden="true" strokeWidth={1.75} className={cn(ICON_SWAP, copied ? ICON_HIDDEN : ICON_SHOWN)} />
            <Check aria-hidden="true" strokeWidth={2.25} className={cn(ICON_SWAP, copied ? ICON_SHOWN : ICON_HIDDEN)} />
          </button>
        </div>
        {role && (
          <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-white py-0.5 pl-1.5 pr-2.5 font-johnson-text text-xs leading-5 text-jj-red ring-1 ring-inset ring-jj-red/15">
            <ShieldCheck aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
            {role}
          </span>
        )}
        <p role="status" className="sr-only">{COPY_STATUS_TEXT[status]}</p>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- account menu

const WHATS_NEW_PATH = '/communication-center?tab=whats-new';
const FALLBACK_EMAIL = 'email@its.jnj.com';

// Directory names carry suffixes like "[Contractor]"; the menu shows the plain name.
const cleanName = (user) => (user?.name || user?.username || 'User').replace(/\s*\[.*?\]\s*/g, ' ').trim();

const PANEL = cn(
  'fixed inset-x-2 top-16 z-50 flex max-h-[calc(100dvh-5rem)] origin-top flex-col overflow-y-auto overscroll-contain',
  'rounded-2xl border border-jj-gray-02 bg-white p-1 shadow-popover outline-none animate-menu-in',
  'sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[22rem] sm:origin-top-right',
);

const UserMenu = () => {
  const { logout, user } = useAuth();
  const { hasPermission, roleDefinition } = useRBAC();
  const { enabled: assistantEnabled, setEnabled: setAssistantEnabled } = useAssistantSettings();
  const { profilePhoto, photoLoading } = useProfilePhoto(user, logout);
  const reduceMotion = useReducedMotion();
  const navigate = useNavigate();
  const menu = useMenu();
  const { close } = menu;
  const menuId = useId();
  const preferencesId = useId();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);

  const canUseAssistant = hasPermission('viewAssistantAvatar');
  // The What's New tab lives in Communication Center, so only people who can open it get the link.
  const canSeeWhatsNew = hasPermission('sendCommunications');
  const roleName = roleDefinition?.name || '';
  const account = { name: cleanName(user), email: user?.email || user?.username || FALLBACK_EMAIL };
  const shortName = firstLast(account.name);

  const toggleAssistant = useCallback(() => setAssistantEnabled(!assistantEnabled), [assistantEnabled, setAssistantEnabled]);
  const toggleReduceMotion = useCallback(() => saveReducedMotion(!reduceMotion), [reduceMotion]);
  const openShortcuts = useCallback(() => { close(); setShortcutsOpen(true); }, [close]);
  const { triggerRef } = menu;
  // The item that opened the dialog is gone, so focus returns to the account button.
  const closeShortcuts = useCallback(() => {
    setShortcutsOpen(false);
    triggerRef.current?.focus();
  }, [triggerRef]);
  const openWhatsNew = useCallback(() => { close(); navigate(WHATS_NEW_PATH); }, [close, navigate]);
  const askSignOut = useCallback(() => setSignOutOpen(true), []);
  const cancelSignOut = useCallback(() => setSignOutOpen(false), []);

  // A failed MSAL logout still has to end the session, so fall back to the logout route.
  const signOut = useCallback(async () => {
    try {
      await logout();
    } catch {
      window.location.replace('/logout');
    }
  }, [logout]);

  return (
    <div ref={menu.containerRef} className="relative flex-shrink-0">
      <button
        ref={menu.triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menu.open ? menuId : undefined}
        aria-label={`Account menu for ${shortName}`}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
        className={cn(
          'flex h-10 items-center gap-2 rounded-xl border bg-white py-1 pl-1 pr-2 transition-[border-color,background-color] duration-150 sm:pr-2.5',
          menu.open ? 'border-jj-red/40 bg-jj-gray-01' : 'border-jj-gray-02 hover:border-jj-red/40',
        )}
      >
        <UserAvatar photo={profilePhoto} loading={photoLoading} name={account.name} />
        <span className="hidden max-w-48 text-left xl:block">
          <span className="block truncate font-johnson-text text-sm leading-4 text-jj-gray-08">{shortName}</span>
          {roleName && <span className="block truncate font-johnson-text text-xs leading-4 text-jj-gray-07">{roleName}</span>}
        </span>
        <ChevronDown
          aria-hidden="true"
          strokeWidth={1.75}
          className={cn('size-4 shrink-0 text-jj-gray-07 transition-transform duration-200 ease-snappy', menu.open && 'rotate-180')}
        />
      </button>

      {menu.open && (
        <div
          ref={menu.menuRef}
          id={menuId}
          role="menu"
          aria-label="Account"
          tabIndex={-1}
          onKeyDown={menu.onMenuKeyDown}
          className={PANEL}
        >
          <IdentityCard user={account} photo={profilePhoto} photoLoading={photoLoading} role={roleName} />

          <div role="group" aria-labelledby={preferencesId} className="pt-1">
            <p id={preferencesId} className="px-3 pb-1 pt-2 font-johnson-text text-xs text-jj-gray-07">Preferences</p>
            {canUseAssistant && (
              <MenuToggle
                icon={Sparkles}
                label="SmartHub Assistant"
                hint="Floating helper on every page"
                checked={assistantEnabled}
                onToggle={toggleAssistant}
              />
            )}
            <MenuToggle
              icon={Waves}
              label="Reduce motion"
              hint="Calmer pages, fewer animations"
              checked={reduceMotion}
              onToggle={toggleReduceMotion}
            />
          </div>

          <MenuSeparator />
          <MenuAction icon={Keyboard} label="Keyboard shortcuts" hint="Keys that work across the hub" onSelect={openShortcuts} />
          {canSeeWhatsNew && (
            <MenuAction icon={Megaphone} label="What's new" hint="Latest releases and changes" onSelect={openWhatsNew} navigates />
          )}

          <MenuSeparator />
          <SignOutButton onSelect={askSignOut} />
        </div>
      )}

      <ShortcutsDialog open={shortcutsOpen} onClose={closeShortcuts} />
      <SignOutDialog open={signOutOpen} onClose={cancelSignOut} onConfirm={signOut} />
    </div>
  );
};

// ------------------------------------------------------------ header

const FILTER_RED  = 'brightness(0) saturate(100%) invert(17%) sepia(100%) saturate(7426%) hue-rotate(3deg) brightness(92%) contrast(118%)';
const FILTER_GRAY = 'brightness(0) saturate(100%) invert(42%) sepia(6%) saturate(656%) hue-rotate(346deg) brightness(92%) contrast(88%)';


// macOS shows ⌘K, everything else Ctrl+K.
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

export default function Header({ navOpen = true, onToggleNav }) {
  const narrow = useMediaQuery(NARROW);

  // The palette itself lives on the dashboard, which is the only page this
  // header renders on — an event keeps the two from having to share state.
  const openPalette = () => window.dispatchEvent(new Event(PALETTE_EVENT));

  return (
    <header
      className="relative z-40 w-full h-14 sm:h-16 flex items-center flex-shrink-0 gap-2 sm:gap-4 pr-3 sm:pr-5 bg-white border-b border-jj-gray-02 select-none"
    >
      {/* Logo sits in the left third; equal flex-basis on both side columns
          keeps the wordmark optically centred regardless of their contents. */}
      <div className="flex items-center flex-grow basis-0 min-w-0">
        {/* Same width as the open sidebar below: logo lines up with the menu,
            chevron sits at the sidebar's edge and stays put when it collapses */}
        {narrow ? (
          <div className="flex items-center gap-2 pl-2 sm:pl-3 min-w-0">
            <MenuButton open={navOpen} onClick={onToggleNav} />
            <img src={jjLogo} alt="Johnson & Johnson" className="hidden sm:block h-8 object-contain" />
          </div>
        ) : (
        <div className="flex items-center justify-between w-[280px] max-w-full flex-shrink-0 pl-5 pr-3">
        <img src={jjLogo} alt="Johnson & Johnson" className="h-10 object-contain" />
        {onToggleNav && (
          <button
            type="button"
            onClick={onToggleNav}
            className="p-1 rounded hover:bg-jj-gray-01 transition-colors duration-150 flex-shrink-0"
            aria-label={navOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          >
            <img src={navOpen ? collapseIcon : expandIcon} alt="" className="w-5 h-5" style={{ filter: FILTER_RED }} />
          </button>
        )}
        </div>
        )}
      </div>

      {/* Wordmark */}
      <div className="flex items-center flex-shrink-0 gap-1.5 sm:gap-2 whitespace-nowrap">
        <span className="font-johnson-display font-bold text-xl sm:text-2xl lg:text-3xl text-jj-red">GRA</span>
        <span className="hidden sm:inline font-johnson-display text-2xl text-jj-gray-07" aria-hidden="true">-</span>
        <span className="font-johnson-display text-base sm:text-xl lg:text-2xl uppercase tracking-wider sm:tracking-widest text-jj-gray-07">SmartHub</span>
      </div>

      <div className="flex items-center justify-end flex-shrink-0 flex-grow basis-0 gap-2 sm:gap-3">

        {/* Search trigger */}
        <button
          type="button"
          onClick={openPalette}
          className="flex items-center justify-center flex-shrink-0 gap-2 h-10 min-w-10 px-2.5 sm:px-3 rounded-xl bg-white border border-jj-gray-02 font-johnson-text text-sm text-jj-gray-07 transition-colors duration-150 hover:border-jj-red/40"
          aria-label="Search tools"
        >
          <img src={searchIcon} alt="" className="w-4 h-4" style={{ filter: FILTER_GRAY }} />
          <span className="hidden md:inline">Search</span>
          <kbd className="hidden lg:inline font-johnson-text text-xs text-jj-gray-07 bg-jj-gray-01 border border-jj-gray-02 rounded px-1.5 py-0.5">
            {isMac ? '⌘K' : 'Ctrl K'}
          </kbd>
        </button>

        <UserMenu />
      </div>
    </header>
  );
}
