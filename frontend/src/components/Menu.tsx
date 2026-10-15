import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuItem { label: string; onClick: () => void; danger?: boolean }

const MARGIN = 8; // keep the popup this far from the window edges

/**
 * Small "⋯" overflow menu. The popup is rendered on <body> with fixed positioning so containers that clip their
 * content (like the player) can't cut it off, and it opens upward when there isn't room below the button.
 */
export function Menu({ items, label = "More actions" }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const b = button.current!.getBoundingClientRect();
    const p = pop.current!.getBoundingClientRect();
    const below = b.bottom + 4;
    const above = b.top - 4 - p.height;
    const top = below + p.height <= window.innerHeight - MARGIN || above < MARGIN
      ? Math.max(MARGIN, Math.min(below, window.innerHeight - MARGIN - p.height))
      : above;
    const left = Math.max(MARGIN, Math.min(b.right - p.width, window.innerWidth - MARGIN - p.width));
    setPos({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !pop.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    // The popup is pinned to where the button was, so close it rather than let it drift when the page moves.
    const onMove = (e: Event) => { if (!pop.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  return (
    <div className="menu">
      <button ref={button} type="button" className="btn ghost icon" aria-label={label} aria-expanded={open}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}>⋯</button>
      {open && createPortal(
        // Hidden until measured so it never flashes in the wrong spot.
        <div ref={pop} className="menu-pop" role="menu"
          style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}>
          {items.map((item) => (
            <button key={item.label} type="button" role="menuitem" className={item.danger ? "danger" : ""}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); item.onClick(); }}>
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
