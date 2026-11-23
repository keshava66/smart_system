import React, { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useRBAC } from "../context/RBACContext";
import { useAssistantSettings } from "../context/AssistantSettingsContext";
import { saveReducedMotion, useReducedMotion } from "../utils/motion";
import { useProfilePhoto } from "../hooks/useProfilePhoto";
import { PALETTE_EVENT } from "../utils/events";
import { NARROW, useMediaQuery } from "../hooks/useMediaQuery";
import MenuButton from "./MenuButton";
import ShortcutsDialog from "./ShortcutsDialog";
import SignOutDialog from "./SignOutDialog";
import { firstLast } from "../utils/displayName";
import { useNavigate } from "react-router-dom";
import userIcon    from "/icons/JJ_Icon_Profile_red.svg";
import logoutIcon  from "/icons/JJ_Icon_Log_Out_RGB.svg";         // Sign out
import chevronIcon from "/icons/JJ_Icon_Chevron_Down.svg";  // Dropdown chevron
import searchIcon  from "/icons/JJ_Icon_Search_RGB.svg";
import jjLogo      from "/jj-logo.png";
import collapseIcon from "/icons/JJ_Icon_Chevron_Left.svg";
import expandIcon   from "/icons/JJ_Icon_Chevron_Right.svg";

const FILTER_RED  = 'brightness(0) saturate(100%) invert(17%) sepia(100%) saturate(7426%) hue-rotate(3deg) brightness(92%) contrast(118%)';
const FILTER_GRAY = 'brightness(0) saturate(100%) invert(42%) sepia(6%) saturate(656%) hue-rotate(346deg) brightness(92%) contrast(88%)';


// macOS shows ⌘K, everything else Ctrl+K.
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

function Toggle({ label, hint, on, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-johnson-text text-jj-gray-08">{label}</p>
        <p className="text-xs text-jj-gray-07 font-johnson-text">{hint}</p>
      </div>
      <button
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={onChange}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-jj-red focus-visible:ring-opacity-40 ${on ? "bg-jj-red" : "bg-jj-gray-03"}`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${on ? "translate-x-6" : "translate-x-1"}`} />
      </button>
    </div>
  );
}

function MenuLink({ onClick, children }) {
  return (
    <button role="menuitem" onClick={onClick}
      className="w-full px-4 py-2 text-left text-sm font-johnson-text text-jj-gray-08 hover:bg-jj-gray-01 transition-colors duration-150">
      {children}
    </button>
  );
}

export default function Header({ navOpen = true, onToggleNav }) {
  const [showDropdown, setShowDropdown] = useState(false);
  const narrow = useMediaQuery(NARROW);
  const { logout, user } = useAuth();
  const { hasPermission, roleDefinition } = useRBAC();
  const { enabled: assistantEnabled, setEnabled: setAssistantEnabled } = useAssistantSettings();
  const reduceMotion = useReducedMotion();
  const canUseAssistant = hasPermission("viewAssistantAvatar");
  // The What's New tab lives in Communication Center, so only people who can open it get the link.
  const canSeeWhatsNew = hasPermission("sendCommunications");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const navigate = useNavigate();

  const { profilePhoto, photoLoading } = useProfilePhoto(user, logout);

  const handleLogout = async () => {
    try {
      await logout();
    } catch (error) {
      console.error('Logout failed:', error);
      window.location.replace('/logout');
    }
  };

  // The palette itself lives on the dashboard, which is the only page this
  // header renders on — an event keeps the two from having to share state.
  const openPalette = () => window.dispatchEvent(new Event(PALETTE_EVENT));

  const displayUser = {
    name: (user?.name || user?.username || "User").replace(/\s*\[.*?\]\s*/g, '').trim(),
    email: user?.email || user?.username || "email@its.jnj.com",
    avatar: profilePhoto
  };

  const roleName = roleDefinition?.name || "";
  const shortName = firstLast(displayUser.name);

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
          className="flex items-center justify-center flex-shrink-0 gap-2 h-9 min-w-9 px-2.5 sm:px-3 rounded-xl bg-white border border-jj-gray-02 font-johnson-text text-sm text-jj-gray-07 transition-colors duration-150 hover:border-jj-red/40"
          aria-label="Search tools"
        >
          <img src={searchIcon} alt="" className="w-4 h-4" style={{ filter: FILTER_GRAY }} />
          <span className="hidden md:inline">Search</span>
          <kbd className="hidden lg:inline font-johnson-text text-xs text-jj-gray-07 bg-jj-gray-01 border border-jj-gray-02 rounded px-1.5 py-0.5">
            {isMac ? '⌘K' : 'Ctrl K'}
          </kbd>
        </button>

        {/* User chip + dropdown */}
        <div className="relative flex-shrink-0">
          <button
            onClick={() => setShowDropdown(!showDropdown)}
            aria-haspopup="menu"
            aria-expanded={showDropdown}
            className="flex items-center gap-2 py-1 pl-1.5 pr-2 sm:pr-3 rounded-2xl bg-white border border-jj-gray-02 transition-colors duration-150 hover:border-jj-red/40"
            aria-label="User menu"
          >
            {photoLoading ? (
              <div className="w-7 h-7 rounded-full bg-jj-gray-02 animate-pulse" />
            ) : displayUser.avatar ? (
              <img
                src={displayUser.avatar}
                alt={displayUser.name}
                className="w-7 h-7 rounded-full object-cover border border-jj-gray-02"
                onError={() => {}}
              />
            ) : (
              <img src={userIcon} alt="User" className="w-7 h-7" />
            )}

            <span className="hidden xl:block text-left leading-tight max-w-[12rem]">
              <span className="block truncate font-johnson-text text-sm text-jj-gray-08">{shortName}</span>
              {roleName && <span className="block truncate font-johnson-text text-xs text-jj-gray-07">{roleName}</span>}
            </span>

            <img
              src={chevronIcon}
              alt=""
              className={`w-3.5 h-3.5 flex-shrink-0 transition-transform duration-200 ${showDropdown ? 'rotate-180' : ''}`}
              style={{ filter: FILTER_GRAY }}
            />
          </button>

          {/* Dropdown Menu */}
          {showDropdown && (
            <div role="menu" className="absolute right-0 mt-2 w-[300px] max-w-[calc(100vw-1.5rem)] bg-white rounded-xl border border-jj-gray-02 shadow-lg z-30 overflow-hidden">
              <div className="flex items-start gap-3 px-4 py-3.5 bg-jj-gray-01/60 border-b border-jj-gray-02">
                {photoLoading ? (
                  <div className="w-10 h-10 flex-shrink-0 rounded-full bg-jj-gray-02 animate-pulse" />
                ) : displayUser.avatar ? (
                  <img src={displayUser.avatar} alt="" className="w-10 h-10 flex-shrink-0 rounded-full object-cover border-2 border-white" />
                ) : (
                  <img src={userIcon} alt="" className="w-10 h-10 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm leading-snug font-johnson-display text-jj-gray-08 break-words">{displayUser.name}</p>
                  <p className="mt-0.5 text-[11px] leading-tight text-jj-gray-07 font-johnson-text truncate" title={displayUser.email}>{displayUser.email}</p>
                  {roleName && (
                    <span className="inline-block mt-1.5 px-2 py-0.5 rounded-md bg-jj-red/10 text-jj-red text-[11px] font-johnson-text">{roleName}</span>
                  )}
                </div>
              </div>

              <p className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-wider text-jj-gray-07 font-johnson-text">Preferences</p>
              {canUseAssistant && (
                <Toggle label="AI assistant" hint="Floating helper on every page"
                  on={assistantEnabled} onChange={() => setAssistantEnabled(!assistantEnabled)} />
              )}
              <Toggle label="Reduce motion" hint="Calmer pages, fewer animations"
                on={reduceMotion} onChange={() => saveReducedMotion(!reduceMotion)} />

              <div className="mt-1 py-1 border-t border-jj-gray-02">
                <MenuLink onClick={() => { setShowDropdown(false); setShortcutsOpen(true); }}>Keyboard shortcuts</MenuLink>
                {canSeeWhatsNew && <MenuLink onClick={() => { setShowDropdown(false); navigate('/communication-center?tab=whats-new'); }}>What&apos;s new</MenuLink>}
              </div>

              <div className="mt-2 py-1 border-t border-jj-gray-02">
                <button
                  role="menuitem"
                  onClick={() => setSignOutOpen(true)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm font-johnson-text text-jj-red hover:bg-red-50 transition-colors duration-200 text-left"
                >
                  <img src={logoutIcon} alt="" className="w-4 h-4 flex-shrink-0" style={{ filter: FILTER_RED }} />
                  <span>Sign out</span>
                </button>
              </div>
            </div>
          )}
          <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
          <SignOutDialog open={signOutOpen} onClose={() => setSignOutOpen(false)} onConfirm={handleLogout} />

          {/* Backdrop to close dropdown */}
          {showDropdown && (
            <div
              className="fixed inset-0 z-20"
              onClick={() => setShowDropdown(false)}
              aria-hidden="true"
            />
          )}
        </div>
      </div>
    </header>
  );
}