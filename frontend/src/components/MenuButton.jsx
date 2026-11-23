import React from "react";

// Hamburger that opens the navigation drawer on phones and tablets.
export default function MenuButton({ open, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={open ? "Close menu" : "Open menu"}
      aria-expanded={open}
      aria-controls="main-navigation"
      className="flex items-center justify-center w-10 h-10 rounded-xl text-jj-gray-08 hover:bg-jj-gray-01 focus-visible:outline focus-visible:outline-2 focus-visible:outline-jj-red flex-shrink-0"
    >
      <svg viewBox="0 0 20 20" className="w-5 h-5" aria-hidden="true">
        <path d="M3 5.5h14M3 10h14M3 14.5h14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    </button>
  );
}
