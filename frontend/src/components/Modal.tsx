import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  onSubmit?: () => void | Promise<void>;
}

export function Modal({ title, onClose, children, footer, wide, onSubmit }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void onSubmit?.();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className={`modal ${wide ? "wide" : ""}`} onSubmit={submit} role="dialog" aria-label={title}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="btn ghost icon" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </form>
    </div>
  );
}

/** Single text-field dialog (create/rename). */
export function PromptDialog({ title, label, initial = "", confirmLabel = "Save", onClose, onConfirm }: {
  title: string; label: string; initial?: string; confirmLabel?: string;
  onClose: () => void; onConfirm: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.select(); }, []);

  const submit = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try { await onConfirm(value.trim()); onClose(); } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <Modal title={title} onClose={onClose} onSubmit={submit} footer={<>
      <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
      <button type="submit" className="btn primary" disabled={busy || !value.trim()}>{confirmLabel}</button>
    </>}>
      <label className="field">
        <span>{label}</span>
        <input ref={input} autoFocus value={value} onChange={(e) => setValue(e.target.value)} maxLength={255} />
      </label>
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

export function ConfirmDialog({ title, message, confirmLabel = "Delete", danger = true, onClose, onConfirm }: {
  title: string; message: ReactNode; confirmLabel?: string; danger?: boolean;
  onClose: () => void; onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    try { await onConfirm(); onClose(); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} onSubmit={submit} footer={<>
      <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
      <button type="submit" autoFocus className={`btn ${danger ? "danger" : "primary"}`} disabled={busy}>{confirmLabel}</button>
    </>}>
      <p>{message}</p>
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}
