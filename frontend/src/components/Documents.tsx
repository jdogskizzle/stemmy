import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from "react";
import { ApiError, api, type DocumentSummary, type SongDocument } from "../api";
import { formatDate } from "../util";
import { Menu } from "./Menu";
import { ConfirmDialog, PromptDialog } from "./Modal";

const AUTOSAVE_MS = 800;
const MAX_CHARS = 200_000;
const MONO_KEY = "stemmy.docMono";

type SaveState = "saved" | "dirty" | "saving" | "error";
type Dialog = { kind: "new" } | { kind: "rename"; doc: DocumentSummary } | { kind: "delete"; doc: DocumentSummary };

/** Lyrics, chord charts and other plain-text documents attached to a song. */
export function Documents({ songId, documents, onChanged }: {
  songId: string; documents: DocumentSummary[]; onChanged: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(documents[0]?.id ?? null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const selected = documents.find((d) => d.id === selectedId) ?? documents[0] ?? null;

  const create = async (title: string, body = "") => {
    const doc = await api.createDocument(songId, title, body);
    setSelectedId(doc.id);
    onChanged();
  };

  const importFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    try {
      const text = (await file.text()).replace(/\r\n?/g, "\n");
      if (text.length > MAX_CHARS) throw new Error("That file is too large for a text document.");
      if (text.includes("\u0000")) throw new Error("That doesn't look like a plain text file.");
      await create(file.name.replace(/\.[^.]+$/, "") || "Imported", text);
    } catch (err) { setError((err as Error).message); }
  };

  const download = async (summary: DocumentSummary) => {
    const doc = await api.document(summary.id);
    const url = URL.createObjectURL(new Blob([doc.body], { type: "text/plain;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${doc.title}.txt` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <section className="documents">
      <div className="documents-head">
        <h2>Lyrics &amp; notes</h2>
        <div className="row gap">
          <button className="btn small" onClick={() => setDialog({ kind: "new" })}>New document</button>
          <button className="btn ghost small" onClick={() => fileInput.current?.click()}>Import .txt</button>
          <input ref={fileInput} type="file" accept=".txt,.md,.chordpro,.cho,.pro,text/plain" hidden onChange={importFile} />
        </div>
      </div>
      {error && <p className="error small">{error}</p>}

      {documents.length === 0 ? (
        <p className="muted small">
          Keep lyrics, chord charts or set notes with the song.{" "}
          <button className="link" onClick={() => void create("Lyrics")}>Start a lyrics sheet</button>
        </p>
      ) : (
        <>
          <div className="doc-tabs" role="tablist" aria-label="Documents">
            {documents.map((d) => (
              <button key={d.id} role="tab" aria-selected={d.id === selected?.id}
                className={`doc-tab ${d.id === selected?.id ? "active" : ""}`} onClick={() => setSelectedId(d.id)}>
                {d.title}
              </button>
            ))}
          </div>
          {selected && (
            <Editor key={selected.id} summary={selected} onSaved={onChanged} menu={[
              { label: "Rename", onClick: () => setDialog({ kind: "rename", doc: selected }) },
              { label: "Download .txt", onClick: () => void download(selected).catch((e) => setError(e.message)) },
              { label: "Delete", danger: true, onClick: () => setDialog({ kind: "delete", doc: selected }) },
            ]} />
          )}
        </>
      )}

      {dialog?.kind === "new" && (
        <PromptDialog title="New document" label="Title" initial={documents.length ? "" : "Lyrics"} confirmLabel="Create"
          onClose={() => setDialog(null)} onConfirm={(title) => create(title)} />
      )}
      {dialog?.kind === "rename" && (
        <PromptDialog title="Rename document" label="Title" initial={dialog.doc.title} onClose={() => setDialog(null)}
          onConfirm={async (title) => { await api.updateDocument(dialog.doc.id, { title }); onChanged(); }} />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog title="Delete document" onClose={() => setDialog(null)}
          message={<>Delete <b>{dialog.doc.title}</b>? This can't be undone.</>}
          onConfirm={async () => { await api.deleteDocument(dialog.doc.id); setSelectedId(null); onChanged(); }} />
      )}
    </section>
  );
}

function Editor({ summary, onSaved, menu }: {
  summary: DocumentSummary; onSaved: () => void; menu: { label: string; onClick: () => void; danger?: boolean }[];
}) {
  const [body, setBody] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>("saved");
  const [conflict, setConflict] = useState<SongDocument | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mono, setMono] = useState(() => { try { return localStorage.getItem(MONO_KEY) === "1"; } catch { return false; } });
  const textarea = useRef<HTMLTextAreaElement>(null);

  // Refs mirror the latest values so timers and unmount cleanup save the right text.
  const bodyRef = useRef("");
  const revisionRef = useRef(0);
  const savedBodyRef = useRef("");
  const timer = useRef<number>();
  const saving = useRef<Promise<void> | null>(null);
  const conflictRef = useRef(false);

  const applyServer = useCallback((doc: SongDocument) => {
    bodyRef.current = savedBodyRef.current = doc.body;
    revisionRef.current = doc.revision;
    setBody(doc.body);
    setState("saved");
  }, []);

  useEffect(() => {
    api.document(summary.id).then(applyServer).catch((e) => setLoadError(e.message));
  }, [summary.id, applyServer]);

  const save = useCallback(async (): Promise<void> => {
    window.clearTimeout(timer.current);
    if (saving.current) { await saving.current; }
    if (conflictRef.current || bodyRef.current === savedBodyRef.current) return;
    const text = bodyRef.current;
    setState("saving");
    saving.current = (async () => {
      try {
        const doc = await api.updateDocument(summary.id, { body: text, revision: revisionRef.current });
        savedBodyRef.current = doc.body;
        revisionRef.current = doc.revision;
        setState(bodyRef.current === text ? "saved" : "dirty");
        onSaved();
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && err.body) {
          conflictRef.current = true;
          setConflict(err.body as SongDocument);
          setState("dirty");
        } else {
          setState("error");
        }
      } finally {
        saving.current = null;
      }
    })();
    await saving.current;
    // Typing during the save left newer text behind; save that too.
    if (!conflictRef.current && bodyRef.current !== savedBodyRef.current) schedule();
  }, [summary.id, onSaved]); // eslint-disable-line react-hooks/exhaustive-deps

  const schedule = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), AUTOSAVE_MS);
  }, [save]);

  // Flush pending edits when switching documents or leaving the page.
  useEffect(() => () => { if (bodyRef.current !== savedBodyRef.current) void save(); }, [save]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (bodyRef.current !== savedBodyRef.current) { void save(); e.preventDefault(); }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [save]);

  // Someone else changed the text while we had no unsaved edits: pick up their version.
  useEffect(() => {
    if (summary.revision > revisionRef.current && revisionRef.current > 0 && state === "saved" && !conflict) {
      api.document(summary.id).then((doc) => {
        if (bodyRef.current === savedBodyRef.current) applyServer(doc);
      }).catch(() => { /* next refresh will retry */ });
    }
  }, [summary.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  // Grow the textarea with its content so the page scrolls instead of a small box.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [body, mono]);

  const onChange = (value: string) => {
    bodyRef.current = value;
    setBody(value);
    if (conflictRef.current) return;
    setState(value === savedBodyRef.current ? "saved" : "dirty");
    schedule();
  };

  const resolveConflict = (keepMine: boolean) => {
    if (!conflict) return;
    conflictRef.current = false;
    setConflict(null);
    if (keepMine) {
      revisionRef.current = conflict.revision;
      savedBodyRef.current = conflict.body;
      void save();
    } else {
      applyServer(conflict);
    }
  };

  const toggleMono = () => {
    setMono((m) => {
      try { localStorage.setItem(MONO_KEY, m ? "0" : "1"); } catch { /* storage unavailable */ }
      return !m;
    });
  };

  if (loadError) return <p className="error small">{loadError}</p>;
  if (body === null) return <div className="spinner" />;

  const status = state === "saving" ? "Saving…" : state === "dirty" ? "Unsaved changes"
    : state === "error" ? "Couldn't save" : `Saved${summary.updated_by ? ` · last edit by ${summary.updated_by}` : ""} · ${formatDate(summary.updated_at)}`;

  return (
    <div className="doc-editor">
      {conflict && (
        <div className="doc-conflict">
          <span className="grow">
            {conflict.updated_by ?? "Someone"} saved a different version while you were editing.
          </span>
          <button className="btn small" onClick={() => resolveConflict(false)}>Use theirs</button>
          <button className="btn small primary" onClick={() => resolveConflict(true)}>Keep mine</button>
        </div>
      )}
      <div className="doc-toolbar">
        <span className={`small ${state === "error" ? "error" : "muted"}`}>{status}</span>
        {state === "error" && <button className="btn ghost small" onClick={() => void save()}>Retry</button>}
        <span className="grow" />
        <button className={`btn ghost small ${mono ? "active" : ""}`} aria-pressed={mono} onClick={toggleMono}
          title="Fixed-width font keeps chords lined up over lyrics">Monospace</button>
        <Menu items={menu} label="Document actions" />
      </div>
      <textarea ref={textarea} className={`doc-text ${mono ? "mono" : ""}`} value={body} spellCheck
        maxLength={MAX_CHARS} placeholder="Start typing…" aria-label={summary.title}
        onChange={(e) => onChange(e.target.value)} onBlur={() => void save()}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); void save(); } }} />
    </div>
  );
}
