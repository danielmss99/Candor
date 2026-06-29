import { useEffect, useRef, useState } from "react";
import type { View } from "../App";
import { useUser } from "../user";
import { Avatar } from "./Avatar";
import { ScalesLogo } from "./ScalesLogo";

interface NavItem {
  label: string;
  target: View;
}

const NAV: NavItem[] = [
  { label: "Home", target: "home" },
  { label: "Meetings", target: "library" },
  { label: "People", target: "people" },
  { label: "Files", target: "files" },
  { label: "Tasks", target: "actions" },
  { label: "Search", target: "search" },
];

interface SidebarProps {
  /** Which nav row reads as active. */
  active: "Home" | "Meetings" | "People" | "Files" | "Tasks" | "Search";
  onNavigate: (view: View) => void;
}

export function Sidebar({ active, onNavigate }: SidebarProps) {
  const {
    name,
    initials,
    onEditName,
    onConnectCalendar,
    calendar,
    onDisconnect,
    onOpenSettings,
    onSignOut,
  } = useUser();
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Close the menu, then run the action.
  const act = (fn?: () => void) => {
    setMenuOpen(false);
    fn?.();
  };

  return (
    <div className="sidebar">
      <button className="brand" onClick={() => onNavigate("landing")} aria-label="Candor — go to landing">
        <ScalesLogo size="sm" />
        <span className="brand-name">Candor</span>
      </button>

      {NAV.map((item) => {
        const isActive = item.label === active;
        return (
          <button
            key={item.label}
            className={`nav-item ${isActive ? "nav-item--active" : ""}`}
            onClick={() => onNavigate(item.target)}
          >
            <span className="nav-bullet" />
            {item.label}
          </button>
        );
      })}

      <div className="sidebar-spacer" />

      <div className="sidebar-user-wrap" ref={wrapRef}>
        {menuOpen && (
          <div className="account-menu" role="menu">
            <button className="account-item" onClick={() => act(onEditName)}>
              <span className="account-item-icon">✎</span>
              Edit name
            </button>
            <button className="account-item" onClick={() => act(onOpenSettings)}>
              <span className="account-item-icon">⚙</span>
              Settings
            </button>

            <div className="account-sep" />
            <div className="account-label">CALENDARS</div>

            {calendar?.google && (
              <div className="account-cal">
                <span className="account-cal-name">Google Calendar</span>
                <button
                  className="account-cal-disc"
                  onClick={() => act(() => onDisconnect?.("google"))}
                >
                  Disconnect
                </button>
              </div>
            )}
            {calendar?.microsoft && (
              <div className="account-cal">
                <span className="account-cal-name">Outlook</span>
                <button
                  className="account-cal-disc"
                  onClick={() => act(() => onDisconnect?.("microsoft"))}
                >
                  Disconnect
                </button>
              </div>
            )}
            {calendar?.apple && (
              <div className="account-cal">
                <span className="account-cal-name">iCloud</span>
                <button
                  className="account-cal-disc"
                  onClick={() => act(() => onDisconnect?.("apple"))}
                >
                  Disconnect
                </button>
              </div>
            )}

            <button className="account-item" onClick={() => act(onConnectCalendar)}>
              <span className="account-item-icon">+</span>
              {calendar?.microsoft || calendar?.google || calendar?.apple
                ? "Add another calendar"
                : "Connect calendar"}
            </button>

            <div className="account-sep" />
            <button className="account-item account-item--danger" onClick={() => act(onSignOut)}>
              <span className="account-item-icon">⏻</span>
              Sign out
            </button>
          </div>
        )}

        <button
          className="sidebar-user"
          onClick={() => setMenuOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <Avatar label={initials} bg="var(--coral)" fg="var(--coral-on)" size={26} />
          <div className="sidebar-user-text">
            <div className="sidebar-user-name">{name}</div>
            <div className="sidebar-user-sub">Account &amp; settings</div>
          </div>
          <span className="sidebar-user-caret">⌄</span>
        </button>
      </div>
    </div>
  );
}
