import { useEffect, useRef, useState, type DragEvent } from "react";
import { api, type Version } from "../api";
import { formatBytes, guessInstrument, todayIso } from "../util";
import { Modal } from "./Modal";

interface Item {
  key: string;
  file: File;
  instrument: string;
  progress: number;
  state: "queued" | "uploading" | "done" | "error";
  error?: string;
}

const PARALLEL_UPLOADS = 2;

/** Create a new version and upload stems to it, or (with `version`) add stems to an existing one. */
export function UploadDialog({ songId, version, onClose, onDone }: {
  songId: string;
  version?: Version;
  onClose: () => void;
  onDone: (versionId: string) => void;
}) {
  const [label, setLabel] = useState(() =>
    new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " practice");
  const [recordedOn, setRecordedOn] = useState(todayIso());
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [instruments, setInstruments] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const abort = useRef(new AbortController());

  useEffect(() => {
    api.instruments().then(({ suggested, used }) => {
      const seen = new Set<string>();
      setInstruments([...used, ...suggested].filter((i) => !seen.has(i.toLowerCase()) && seen.add(i.toLowerCase())));
    }).catch(() => {});
    const controller = abort.current;
    return () => controller.abort();
  }, []);

  const addFiles = (files: FileList | File[]) => {
    const audio = Array.from(files).filter((f) => f.type.startsWith("audio/") || /\.(wav|aiff?|flac|mp3|m4a|aac|ogg|opus|wma|caf|webm)$/i.test(f.name));
    setItems((prev) => [...prev, ...audio.map((file) => ({
      key: `${file.name}-${file.size}-${Math.random()}`, file,
      instrument: guessInstrument(file.name), progress: 0, state: "queued" as const,
    }))]);
  };

  const update = (key: string, patch: Partial<Item>) =>
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const pending = items.filter((i) => i.state !== "done");
  const missingInstrument = pending.some((i) => !i.instrument.trim());
  const canSubmit = !busy && pending.length > 0 && !missingInstrument && (version || label.trim());

  // Set once the version exists, so retries after a partial failure reuse it.
  const [versionId, setVersionId] = useState<string | null>(version?.id ?? null);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    let target = versionId;
    if (!target) {
      try {
        target = (await api.createVersion(songId, { label: label.trim(), recorded_on: recordedOn || null, notes })).id;
        setVersionId(target);
      } catch (e) {
        setError((e as Error).message);
        setBusy(false);
        return;
      }
    }
    const queue = [...pending];
    let failures = 0;
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const key = item.key;
        update(key, { state: "uploading", progress: 0, error: undefined });
        try {
          await api.uploadTrack(target, item.file, item.instrument.trim(), (p) => update(key, { progress: p }), abort.current.signal);
          update(key, { state: "done", progress: 1 });
        } catch (e) {
          failures++;
          update(key, { state: "error", error: (e as Error).message });
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL_UPLOADS }, worker));
    if (abort.current.signal.aborted) return;
    onDone(target);
    if (failures === 0) onClose();
    else {
      setError(`${failures} file${failures === 1 ? "" : "s"} failed to upload.`);
      setBusy(false);
    }
  };

  return (
    <Modal wide title={version ? `Add tracks to “${version.label}”` : "Upload new version"} onClose={onClose}
      onSubmit={submit}
      footer={<>
        <span className="muted small grow">
          {items.length > 0 && `${items.length} file${items.length === 1 ? "" : "s"} · ${formatBytes(items.reduce((n, i) => n + i.file.size, 0))}`}
        </span>
        <button type="button" className="btn ghost" onClick={onClose}>{busy ? "Cancel uploads" : "Cancel"}</button>
        <button type="submit" className="btn primary" disabled={!canSubmit}>
          {busy ? "Uploading…" : error ? "Retry failed" : "Upload"}
        </button>
      </>}>
      {!versionId && (
        <div className="form-grid">
          <label className="field">
            <span>Version name</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Practice, Live take 2" disabled={busy} />
          </label>
          <label className="field">
            <span>Recorded on</span>
            <input type="date" value={recordedOn} onChange={(e) => setRecordedOn(e.target.value)} disabled={busy} />
          </label>
          <label className="field span-2">
            <span>Notes (optional)</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Tempo change, new bridge…" disabled={busy} />
          </label>
        </div>
      )}

      <div className={`dropzone ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)} onDrop={onDrop}
        onClick={() => !busy && fileInput.current?.click()}>
        <strong>Drop stems here</strong> or click to choose files
        <span className="muted small">One file per instrument. WAV, FLAC, AIFF, MP3, M4A, OGG…</span>
        <input ref={fileInput} type="file" multiple accept="audio/*,.wav,.flac,.aif,.aiff,.mp3,.m4a,.ogg,.opus" hidden
          onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
      </div>

      {items.length > 0 && (
        <div className="upload-list">
          {items.map((item) => (
            <div key={item.key} className={`upload-row ${item.state}`}>
              <div className="upload-file">
                <span className="ellipsis" title={item.file.name}>{item.file.name}</span>
                <span className="muted small">{formatBytes(item.file.size)}</span>
              </div>
              <input list="stemmy-instruments" className={`instrument-input ${!item.instrument.trim() ? "invalid" : ""}`}
                placeholder="Instrument" value={item.instrument} disabled={busy || item.state === "done"}
                onChange={(e) => update(item.key, { instrument: e.target.value })} />
              <div className="upload-status">
                {item.state === "uploading" && <div className="bar"><div style={{ width: `${item.progress * 100}%` }} /></div>}
                {item.state === "done" && <span className="ok">✓</span>}
                {item.state === "error" && <span className="error small" title={item.error}>{item.error}</span>}
                {item.state === "queued" && !busy && (
                  <button type="button" className="btn ghost icon" aria-label="Remove"
                    onClick={() => setItems((prev) => prev.filter((i) => i.key !== item.key))}>✕</button>
                )}
              </div>
            </div>
          ))}
          <datalist id="stemmy-instruments">
            {instruments.map((i) => <option key={i} value={i} />)}
          </datalist>
        </div>
      )}
      {missingInstrument && <p className="muted small">Choose an instrument for every file.</p>}
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}
