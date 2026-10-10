import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { ApiError, api, type DocumentFormat, type DocumentSummary, type SongDocument } from "../api";
import {
  TABLE_TEMPLATE, cleanImportedMarkdown, insertBlock, prefixLines, renderMarkdown, wrapSelection,
} from "../markdown";
import { formatDate } from "../util";
import { Menu } from "./Menu";
import { ConfirmDialog, Modal, PromptDialog } from "./Modal";

const AUTOSAVE_MS = 800;
const MAX_CHARS = 200_000;
const MONO_KEY = "stemmy.docMono";
const VIEW_KEY = "stemmy.mdView";
const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd)$/i;

type SaveState = "saved" | "dirty" | "saving" | "error";
type MarkdownView = "write" | "split" | "preview";
type Dialog = { kind: "new" } | { kind: "rename"; doc: DocumentSummary } | { kind: "delete"; doc: DocumentSummary };

/** Lyrics, chord charts and other plain-text documents attached to a song. */
export function Documents({ songId, documents, onChanged }: {
  songId: string; documents: DocumentSummary[]; onChanged: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(documents[0]?.id ?? null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const selected = documents.find((d) => d.id === selectedId) ?? documents[0] ?? null;

  const create = async (title: string, format: DocumentFormat, body = "") => {
    const doc = await api.createDocument(songId, { title, format, body });
    setSelectedId(doc.id);
    onChanged();
  };

  const importFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setNotice(null);
    try {
      let text = (await file.text()).replace(/\r\n?/g, "\n");
      if (text.includes("\u0000")) throw new Error("That doesn't look like a text file.");
      const format: DocumentFormat = MARKDOWN_EXT.test(file.name) ? "markdown" : "text";
      if (format === "markdown") {
        const cleaned = cleanImportedMarkdown(text);
        text = cleaned.text;
        if (cleaned.removedImages) {
          setNotice(`Left out ${cleaned.removedImages} embedded image${cleaned.removedImages === 1 ? "" : "s"}; ` +
            "documents hold text only.");
        }
      }
      if (text.length > MAX_CHARS) throw new Error("That file is too large for a text document.");
      await create(file.name.replace(/\.[^.]+$/, "") || "Imported", format, text);
    } catch (err) { setError((err as Error).message); }
  };

  const download = async (summary: DocumentSummary) => {
    const doc = await api.document(summary.id);
    const markdown = doc.format === "markdown";
    const type = markdown ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8";
    const url = URL.createObjectURL(new Blob([doc.body], { type }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${doc.title}.${markdown ? "md" : "txt"}` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const setFormat = async (doc: DocumentSummary, format: DocumentFormat) => {
    try { await api.updateDocument(doc.id, { format }); onChanged(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <section className="documents">
      <div className="documents-head">
        <h2>Lyrics &amp; notes</h2>
        <div className="row gap">
          <button className="btn small" onClick={() => setDialog({ kind: "new" })}>New document</button>
          <button className="btn ghost small" onClick={() => fileInput.current?.click()}>Import file</button>
          <input ref={fileInput} type="file" hidden onChange={importFile}
            accept=".txt,.md,.markdown,.mdown,.mkd,.chordpro,.cho,.pro,text/plain,text/markdown" />
        </div>
      </div>
      {error && <p className="error small">{error}</p>}
      {notice && <p className="muted small">{notice}</p>}

      {documents.length === 0 ? (
        <p className="muted small">
          Keep lyrics, chord charts or set notes with the song.{" "}
          <button className="link" onClick={() => void create("Lyrics", "text")}>Start a lyrics sheet</button>
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
              selected.format === "markdown"
                ? { label: "Switch to plain text", onClick: () => void setFormat(selected, "text") }
                : { label: "Switch to Markdown", onClick: () => void setFormat(selected, "markdown") },
              { label: selected.format === "markdown" ? "Download .md" : "Download .txt", onClick: () => void download(selected).catch((e) => setError(e.message)) },
              { label: "Delete", danger: true, onClick: () => setDialog({ kind: "delete", doc: selected }) },
            ]} />
          )}
        </>
      )}

      {dialog?.kind === "new" && (
        <NewDocumentDialog initialTitle={documents.length ? "" : "Lyrics"} onClose={() => setDialog(null)}
          onCreate={(title, format) => create(title, format)} />
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
  const markdown = summary.format === "markdown";
  const [view, setView] = useState<MarkdownView | null>(null);
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

  // Markdown opens in the last-used view, or the rendered preview when there's something to read.
  const effectiveView: MarkdownView = view ?? (() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY) as MarkdownView | null;
      if (saved === "write" || saved === "split" || saved === "preview") return saved;
    } catch { /* storage unavailable */ }
    return body ? "preview" : "write";
  })();
  const chooseView = (v: MarkdownView) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage unavailable */ }
  };
  const showEditor = !markdown || effectiveView !== "preview";
  const showPreview = markdown && effectiveView !== "write";
  const html = useMemo(() => (showPreview && body !== null ? renderMarkdown(body) : ""), [showPreview, body]);

  // Grow the textarea with its content so the page scrolls instead of a small box.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [body, mono, showEditor, effectiveView]);

  const onChange = (value: string) => {
    bodyRef.current = value;
    setBody(value);
    if (conflictRef.current) return;
    setState(value === savedBodyRef.current ? "saved" : "dirty");
    schedule();
  };

  // Toolbar edits normally fire an input event; when the browser can't, read the textarea back directly.
  const syncFromTextarea = () => textarea.current && onChange(textarea.current.value);
  const tools = (el: HTMLTextAreaElement) => ({
    bold: () => wrapSelection(el, "**", "**", "bold text", syncFromTextarea),
    italic: () => wrapSelection(el, "_", "_", "italic text", syncFromTextarea),
    heading: () => prefixLines(el, () => "## ", /^#{1,6} /, syncFromTextarea),
    bullets: () => prefixLines(el, () => "- ", /^[-*+] /, syncFromTextarea),
    numbers: () => prefixLines(el, (i) => `${i + 1}. `, /^\d+\. /, syncFromTextarea),
    table: () => insertBlock(el, TABLE_TEMPLATE, syncFromTextarea),
    link: () => wrapSelection(el, "[", "](https://)", "link text", syncFromTextarea),
  });
  const runTool = (name: keyof ReturnType<typeof tools>) => {
    if (textarea.current) tools(textarea.current)[name]();
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
        {markdown && (
          <div className="segmented" role="group" aria-label="View">
            {(["write", "split", "preview"] as const).map((v) => (
              <button key={v} className={`${effectiveView === v ? "active" : ""} ${v === "split" ? "wide-only" : ""}`}
                aria-pressed={effectiveView === v} onClick={() => chooseView(v)}>
                {v === "write" ? "Write" : v === "split" ? "Split" : "Preview"}
              </button>
            ))}
          </div>
        )}
        {showEditor && (
          <button className={`btn ghost small ${mono ? "active" : ""}`} aria-pressed={mono} onClick={toggleMono}
            title="Fixed-width font keeps chords lined up over lyrics">Monospace</button>
        )}
        <Menu items={menu} label="Document actions" />
      </div>
      {markdown && showEditor && (
        <div className="md-tools" role="toolbar" aria-label="Formatting">
          <button title="Bold (Ctrl+B)" onClick={() => runTool("bold")}><b>B</b></button>
          <button title="Italic (Ctrl+I)" onClick={() => runTool("italic")}><i>I</i></button>
          <button title="Heading" onClick={() => runTool("heading")}>H</button>
          <button title="Bulleted list" onClick={() => runTool("bullets")}>• List</button>
          <button title="Numbered list" onClick={() => runTool("numbers")}>1. List</button>
          <button title="Insert table" onClick={() => runTool("table")}>Table</button>
          <button title="Link" onClick={() => runTool("link")}>Link</button>
        </div>
      )}
      <div className={`doc-body ${markdown && effectiveView === "split" ? "split" : ""}`}>
        {showEditor && (
          <textarea ref={textarea} className={`doc-text ${mono ? "mono" : ""}`} value={body} spellCheck
            maxLength={MAX_CHARS} placeholder={markdown ? "Write Markdown… e.g. ## Verse 1" : "Start typing…"}
            aria-label={summary.title} onChange={(e) => onChange(e.target.value)} onBlur={() => void save()}
            onKeyDown={(e) => {
              if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
              const key = e.key.toLowerCase();
              if (key === "s") { e.preventDefault(); void save(); }
              else if (markdown && key === "b") { e.preventDefault(); runTool("bold"); }
              else if (markdown && key === "i") { e.preventDefault(); runTool("italic"); }
            }} />
        )}
        {showPreview && (
          body.trim()
            ? <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
            : <p className="markdown muted">Nothing to preview yet.</p>
        )}
      </div>
    </div>
  );
}

function NewDocumentDialog({ initialTitle, onClose, onCreate }: {
  initialTitle: string; onClose: () => void; onCreate: (title: string, format: DocumentFormat) => Promise<void>;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [format, setFormat] = useState<DocumentFormat>("text");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try { await onCreate(title.trim(), format); onClose(); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <Modal title="New document" onClose={onClose} onSubmit={submit} footer={<>
      <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
      <button type="submit" className="btn primary" disabled={busy || !title.trim()}>Create</button>
    </>}>
      <label className="field"><span>Title</span>
        <input autoFocus value={title} maxLength={255} onChange={(e) => setTitle(e.target.value)} placeholder="Lyrics, Chords, Set notes…" /></label>
      <div className="field">
        <span>Format</span>
        <label className="checkbox"><input type="radio" name="format" checked={format === "text"} onChange={() => setFormat("text")} />
          Plain text: lyrics and chord charts exactly as typed</label>
        <label className="checkbox"><input type="radio" name="format" checked={format === "markdown"} onChange={() => setFormat("markdown")} />
          Markdown: headings, bold, lists and tables</label>
      </div>
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}
