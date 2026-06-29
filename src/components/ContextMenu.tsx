import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onClick?: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - 8) {
      left = window.innerWidth - rect.width - 8;
    }
    if (top + rect.height > window.innerHeight - 8) {
      top = window.innerHeight - rect.height - 8;
    }
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;
  }, [x, y, items]);

  return (
    <div className="ctx-backdrop" role="presentation">
      <div ref={ref} className="ctx-menu" style={{ left: x, top: y }} role="menu">
        {items.map((item) =>
          item.separator ? (
            <div key={item.id} className="ctx-sep" role="separator" />
          ) : (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`ctx-item ${item.danger ? "ctx-item--danger" : ""}`}
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled || !item.onClick) return;
                item.onClick();
                onClose();
              }}
            >
              {item.label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

/** Attach to a meeting row/card — prevents default browser menu. */
export function meetingContextHandler(
  e: React.MouseEvent,
  onOpen: (x: number, y: number) => void,
) {
  e.preventDefault();
  e.stopPropagation();
  onOpen(e.clientX, e.clientY);
}
