import { useEffect, useRef, useState } from "react";

export interface MenuItem { label: string; onClick: () => void; danger?: boolean }

/** Small "⋯" overflow menu. */
export function Menu({ items, label = "More actions" }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div className="menu" ref={root}>
      <button type="button" className="btn ghost icon" aria-label={label} aria-expanded={open}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}>⋯</button>
      {open && (
        <div className="menu-pop" role="menu">
          {items.map((item) => (
            <button key={item.label} type="button" role="menuitem" className={item.danger ? "danger" : ""}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); item.onClick(); }}>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
