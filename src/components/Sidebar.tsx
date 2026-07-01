import { useEffect, useRef, useState } from "react";
import type { SidebarFolderProps, View } from "../App";
import { useUser } from "../user";
import { Avatar } from "./Avatar";
import { FolderActionsDropdown } from "./FolderActionsDropdown";
import { FolderTree } from "./FolderTree";
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
  { label: "Dictionary", target: "dictionary" },
];

interface SidebarProps extends Partial<SidebarFolderProps> {
  active: "Home" | "Meetings" | "People" | "Files" | "Tasks" | "Search" | "Dictionary";
  onNavigate: (view: View) => void;
}

export function Sidebar({
  active,
  onNavigate,
  filesTree,
  filesSelectedFolderId,
  onFilesFolderSelect,
  folderNames,
  onFilesFolderChange,
  onFolderCreated,
  filesMeetings,
  filesItemCounts,
  filesEditingFolder,
  onFilesEditingFolderChange,
  filesExpandFolderId,
  onFilesExpandFolderIdConsumed,
}: SidebarProps) {
  const {
    name,
    initials,
    avatarUrl,
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
  const [filesTreeOpen, setFilesTreeOpen] = useState(true);
  const wrapRef = useRef<HTMLDivElement>(null);

  const isFilesActive = active === "Files";
  const showFilesTree = filesTreeOpen && filesTree !== undefined;

  const handleFolderSelect = (folderId: string) => {
    onFilesFolderSelect?.(folderId);
    if (!isFilesActive) onNavigate("files");
  };

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

  return (
    <div className="sidebar">
      <button className="brand" onClick={() => onNavigate("landing")} aria-label="Candor">
        <ScalesLogo size="sm" />
        <span className="brand-name">Candor</span>
      </button>

      {renderSection("Work", NAV_WORK, workOpen, setWorkOpen)}
      {renderSection("Manage", NAV_MANAGE, manageOpen, setManageOpen)}

      <div className="nav-section nav-section--files">
        <div className={`nav-files-row ${isFilesActive ? "nav-files-row--active" : ""}`}>
          {filesTree !== undefined && (
            <button
              type="button"
              className="nav-files-chevron"
              onClick={() => setFilesTreeOpen((o) => !o)}
              aria-expanded={filesTreeOpen}
              aria-label={filesTreeOpen ? "Collapse folders" : "Expand folders"}
            >
              {filesTreeOpen ? "▾" : "▸"}
            </button>
          )}
          <button
            type="button"
            className={`nav-item nav-item--files ${isFilesActive ? "nav-item--active" : ""}`}
            onClick={() => {
              onNavigate("files");
              setFilesTreeOpen(true);
            }}
          >
            <span className="nav-bullet" />
            Files
          </button>
          <FolderActionsDropdown
            compact
            selectedFolderId={filesSelectedFolderId ?? "inbox"}
            folderNames={folderNames}
            onCreated={(id, parentId) => {
              if (id) onFolderCreated?.(id, parentId);
              onFilesFolderChange?.();
              if (!isFilesActive) onNavigate("files");
              setFilesTreeOpen(true);
            }}
          />
        </div>
        {showFilesTree && (
          <div className="nav-files-tree">
            <FolderTree
              tree={filesTree}
              selectedId={filesSelectedFolderId ?? "inbox"}
              onSelect={handleFolderSelect}
              onChange={() => onFilesFolderChange?.()}
              meetings={filesMeetings}
              itemCounts={filesItemCounts}
              editingFolder={filesEditingFolder}
              onEditingFolderChange={onFilesEditingFolderChange}
              expandFolderId={filesExpandFolderId}
              onExpandFolderIdConsumed={onFilesExpandFolderIdConsumed}
            />
          </div>
        )}
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
                  onClick={() => act(() => onDisconnect?.("apple"))}
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
          <Avatar
            label={initials}
            src={avatarUrl}
            bg="var(--coral)"
            fg="var(--coral-on)"
            size={26}
          />
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
