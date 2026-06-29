import { useEffect, useRef, useState } from "react";
import type { View } from "../App";
import { useUser } from "../user";
import { Avatar } from "./Avatar";
import { FolderActionsDropdown } from "./FolderActionsDropdown";
import { ScalesLogo } from "./ScalesLogo";

interface NavItem {
  label: string;
  target: View;
}

const NAV_WORK: NavItem[] = [
  { label: "Home", target: "home" },
  { label: "Meetings", target: "library" },
];

const NAV_MANAGE: NavItem[] = [
  { label: "People", target: "people" },
  { label: "Tasks", target: "actions" },
  { label: "Search", target: "search" },
];

interface SidebarProps {
  active: "Home" | "Meetings" | "People" | "Files" | "Tasks" | "Search";
  onNavigate: (view: View) => void;
  /** Selected folder when Files view is open — used by the Files + menu. */
  filesSelectedFolderId?: string;
  onFilesFolderChange?: () => void;
}

export function Sidebar({
  active,
  onNavigate,
  filesSelectedFolderId,
  onFilesFolderChange,
}: SidebarProps) {
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
  const [workOpen, setWorkOpen] = useState(true);
  const [manageOpen, setManageOpen] = useState(true);
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

  const act = (fn?: () => void) => {
    setMenuOpen(false);
    fn?.();
  };

  const renderSection = (
    title: string,
    items: NavItem[],
    open: boolean,
    setOpen: (v: boolean) => void,
  ) => (
    <div className="nav-section">
      <button
        type="button"
        className="nav-section-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} {title}
      </button>
      {open && (
        <div className="nav-section-items">
          {items.map((item) => {
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
        </div>
      )}
    </div>
  );

  const isFilesActive = active === "Files";

  return (
    <div className="sidebar">
      <button className="brand" onClick={() => onNavigate("landing")} aria-label="Candor v2">
        <ScalesLogo size="sm" />
        <span className="brand-name">
          Candor
          <span className="brand-v2-badge">v2</span>
        </span>
      </button>

      {renderSection("Work", NAV_WORK, workOpen, setWorkOpen)}
      {renderSection("Manage", NAV_MANAGE, manageOpen, setManageOpen)}

      <div className="nav-section nav-section--files">
        <div className={`nav-files-row ${isFilesActive ? "nav-files-row--active" : ""}`}>
          <button
            type="button"
            className={`nav-item nav-item--files ${isFilesActive ? "nav-item--active" : ""}`}
            onClick={() => onNavigate("files")}
          >
            <span className="nav-bullet" />
            Files
          </button>
          <FolderActionsDropdown
            compact
            selectedFolderId={filesSelectedFolderId ?? "inbox"}
            onCreated={() => {
              onFilesFolderChange?.();
              if (!isFilesActive) onNavigate("files");
            }}
          />
        </div>
      </div>

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
            <div className="account-label">Calendars</div>

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
                  onClick={() => act(() => onDisconnect?.("microsoft"))}
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
