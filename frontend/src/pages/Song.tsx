import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, downloadAuthenticated, type Song, type Track, type Version } from "../api";
import { decodedCache, prefetchMedia } from "../audio/cache";
import { getEngine } from "../audio/engine";
import { Menu } from "../components/Menu";
import { Documents } from "../components/Documents";
import { ConfirmDialog, Modal, PromptDialog } from "../components/Modal";
import { Player } from "../components/Player";
import { UploadDialog } from "../components/UploadDialog";
import { formatBytes, formatDate } from "../util";

type Dialog =
  | { kind: "upload" } | { kind: "addTracks"; version: Version } | { kind: "editVersion"; version: Version }
  | { kind: "deleteVersion"; version: Version } | { kind: "renameSong" } | { kind: "deleteSong" }
  | { kind: "renameTrack"; track: Track } | { kind: "deleteTrack"; track: Track };

/** The day a version sorts under: its recording date, else its (UTC) upload day, matching the server. */
const versionDay = (v: Version) => v.recorded_on ?? v.created_at.slice(0, 10);

export default function SongPage() {
  const { songId } = useParams() as { songId: string };
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [song, setSong] = useState<Song | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(params.get("upload") ? { kind: "upload" } : null);
  const engine = getEngine();

  const reload = useCallback(() => api.song(songId).then(setSong).catch((e) => setError(e.message)), [songId]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => () => engine.unload(), [engine]);

  // Versions run oldest to newest, left to right; the newest is selected unless the URL picks one.
  const version = song?.versions.find((v) => v.id === params.get("v")) ?? song?.versions[song.versions.length - 1] ?? null;
  const selectVersion = (id: string) => setParams((p) => { p.set("v", id); p.delete("upload"); return p; }, { replace: true });

  // Keep the selected version in view; the newest sits at the far right of a list that can scroll.
  const versionStrip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    versionStrip.current?.querySelector(".version-pill.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [version?.id, song?.versions.length]);

  // Same-day versions have no natural order, so the band sets it by swapping neighbours.
  const moveVersion = async (v: Version, step: -1 | 1) => {
    if (!song) return;
    const ids = song.versions.map((x) => x.id);
    const i = ids.indexOf(v.id);
    [ids[i], ids[i + step]] = [ids[i + step], ids[i]];
    // Fails only if someone added or removed a version meanwhile; the reload shows the real order either way.
    await api.orderVersions(song.id, ids).catch(() => {});
    await reload();
  };

  // Poll while uploads are processing.
  const processing = song?.versions.some((v) => v.tracks.some((t) => t.status === "pending" || t.status === "processing"));
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(reload, 2500);
    return () => clearInterval(t);
  }, [processing, reload]);

  const readyTracks = useMemo(() => version?.tracks.filter((t) => t.status === "ready" && t.audio_url) ?? [], [version]);
  const laneKey = readyTracks.map((t) => `${t.id}:${t.content_hash}:${t.instrument}`).join("|");

  // Load the selected version's stems into the engine, then warm the cache for other versions.
  useEffect(() => {
    if (!song || !readyTracks.length) { engine.unload(); return; }
    const urls = readyTracks.map((t) => t.audio_url!);
    decodedCache.pin(urls);
    let cancelled = false;
    engine.load(readyTracks.map((t) => ({ id: t.id, instrument: t.instrument, url: t.audio_url! }))).then(() => {
      if (cancelled) return;
      const others = song.versions.filter((v) => v.id !== version?.id).slice(-3).reverse()
        .flatMap((v) => v.tracks.filter((t) => t.audio_url).map((t) => t.audio_url!));
      void prefetchMedia(others);
    });
    return () => { cancelled = true; };
  }, [laneKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard: Space play/pause, arrows skip, L loop, 1-9 mute, Shift+1-9 solo, [ ] switch version.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (dialog || target.closest("input, textarea, select, [contenteditable]")) return;
      if (e.metaKey || e.ctrlKey) return;
      const lanes = engine.getState().lanes;
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (e.code === "Space") { e.preventDefault(); engine.toggle(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); engine.skip(e.shiftKey ? -15 : -5); }
      else if (e.key === "ArrowRight") { e.preventDefault(); engine.skip(e.shiftKey ? 15 : 5); }
      else if (e.key === "Home") engine.seek(0);
      else if (e.key.toLowerCase() === "l") engine.setLoopEnabled(!engine.getState().loopEnabled);
      else if (digit) {
        const lane = lanes[Number(digit[1]) - 1];
        if (!lane) return;
        if (e.shiftKey) engine.soloExclusive(lane.id);
        else engine.setMute(lane.id, !lane.muted);
      } else if ((e.key === "[" || e.key === "]") && song && version) {
        const i = song.versions.findIndex((v) => v.id === version.id);
        const next = song.versions[i + (e.key === "]" ? 1 : -1)]; // list is oldest-first; "]" = newer
        if (next) selectVersion(next.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (error) return <div className="page"><p className="error">{error}</p><Link to="/">Back to library</Link></div>;
  if (!song) return <div className="page"><div className="spinner" /></div>;

  const close = () => setDialog(null);
  const parent = song.breadcrumbs[song.breadcrumbs.length - 1];
  const notReady = version?.tracks.filter((t) => t.status !== "ready") ?? [];

  return (
    <div className="page">
      <nav className="crumbs">
        <Link to="/">Library</Link>
        {song.breadcrumbs.map((c) => (
          <span key={c.id}><span className="sep">/</span><Link to={`/folders/${c.id}`}>{c.name}</Link></span>
        ))}
      </nav>
      <div className="page-head">
        <h1>{song.title}{song.size_bytes > 0 && <span className="head-meta">{formatBytes(song.size_bytes)}</span>}</h1>
        <div className="row gap">
          <button className="btn primary" onClick={() => setDialog({ kind: "upload" })}>Upload version</button>
          <Menu items={[
            { label: "Rename song", onClick: () => setDialog({ kind: "renameSong" }) },
            { label: "Delete song", danger: true, onClick: () => setDialog({ kind: "deleteSong" }) },
          ]} />
        </div>
      </div>

      {song.versions.length === 0 ? (
        <div className="empty">
          <p>No versions yet.</p>
          <p className="muted">Upload a recording: one audio file per instrument, so everyone can solo their part.</p>
          <button className="btn primary" onClick={() => setDialog({ kind: "upload" })}>Upload first version</button>
        </div>
      ) : (
        <>
          <div className="versions" role="tablist" aria-label="Versions" ref={versionStrip}>
            {song.versions.map((v) => (
              <button key={v.id} role="tab" aria-selected={v.id === version?.id}
                className={`version-pill ${v.id === version?.id ? "active" : ""}`} onClick={() => selectVersion(v.id)}>
                <span className="version-label">{v.label}</span>
                <span className="version-date">{v.recorded_on ? formatDate(v.recorded_on) : formatDate(v.created_at)}</span>
                {!v.ready && v.track_count > 0 && <span className="badge">processing</span>}
              </button>
            ))}
          </div>

          {version && (
            <div className="version-meta">
              <div className="grow">
                <span className="muted small">
                  {version.track_count} track{version.track_count === 1 ? "" : "s"}
                  {version.size_bytes > 0 && ` · ${formatBytes(version.size_bytes)}`}
                  {version.created_by && ` · uploaded by ${version.created_by}`}
                  {" · "}<Link to={`/dates/${versionDay(version)}`} className="link">Everything from {formatDate(versionDay(version))}</Link>
                </span>
                {version.notes && <p className="notes">{version.notes}</p>}
              </div>
              <button className="btn small" onClick={() => setDialog({ kind: "addTracks", version })}>Add tracks</button>
              <Menu items={[
                { label: "Edit version", onClick: () => setDialog({ kind: "editVersion", version }) },
                ...sameDayMoves(song.versions, version, moveVersion),
                { label: "Delete version", danger: true, onClick: () => setDialog({ kind: "deleteVersion", version }) },
              ]} />
            </div>
          )}

          {readyTracks.length > 0 && (
            <Player tracks={readyTracks} fallbackDuration={version?.duration ?? 0} trackMenu={(track) => [
              { label: "Rename instrument", onClick: () => setDialog({ kind: "renameTrack", track }) },
              { label: `Download original (${formatBytes(track.size_bytes)})`, onClick: () => void downloadAuthenticated(track.original_url, track.original_filename) },
              { label: "Delete track", danger: true, onClick: () => setDialog({ kind: "deleteTrack", track }) },
            ]} />
          )}

          {notReady.length > 0 && (
            <div className="processing-list">
              {notReady.map((t) => (
                <div key={t.id} className="processing-row">
                  <span className="lane-name">{t.instrument}</span>
                  <span className="muted small ellipsis">{t.original_filename}</span>
                  {t.status === "error" ? (
                    <>
                      <span className="error small ellipsis" title={t.error ?? ""}>Failed: {t.error}</span>
                      <button className="btn small" onClick={() => api.reprocessTrack(t.id).then(reload)}>Retry</button>
                      <button className="btn ghost small" onClick={() => setDialog({ kind: "deleteTrack", track: t })}>Remove</button>
                    </>
                  ) : (
                    <span className="muted small"><span className="spinner inline" /> {t.status === "pending" ? "Queued" : "Processing"}…</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {readyTracks.length > 0 && (
            <p className="muted small shortcuts">
              Click the waveform to seek, drag to set a loop. Keys: <kbd>Space</kbd> play · <kbd>←</kbd><kbd>→</kbd> skip ·
              <kbd>1</kbd>–<kbd>9</kbd> mute · <kbd>Shift</kbd>+<kbd>1</kbd>–<kbd>9</kbd> solo · <kbd>L</kbd> loop · <kbd>[</kbd><kbd>]</kbd> older/newer version
            </p>
          )}
        </>
      )}

      <Documents songId={song.id} documents={song.documents} onChanged={reload} />

      {dialog?.kind === "upload" && (
        <UploadDialog songId={song.id} onClose={() => { close(); setParams((p) => { p.delete("upload"); return p; }, { replace: true }); }}
          onDone={(id) => { reload(); selectVersion(id); }} />
      )}
      {dialog?.kind === "addTracks" && (
        <UploadDialog songId={song.id} version={dialog.version} onClose={close} onDone={() => reload()} />
      )}
      {dialog?.kind === "editVersion" && (
        <EditVersionDialog version={dialog.version} onClose={close} onSaved={reload} />
      )}
      {dialog?.kind === "deleteVersion" && (
        <ConfirmDialog title="Delete version" onClose={close}
          message={<>Delete <b>{dialog.version.label}</b> and its {dialog.version.track_count} track(s)? This can't be undone.</>}
          onConfirm={async () => { await api.deleteVersion(dialog.version.id); setParams({}, { replace: true }); await reload(); }} />
      )}
      {dialog?.kind === "renameSong" && (
        <PromptDialog title="Rename song" label="Title" initial={song.title} onClose={close}
          onConfirm={async (title) => { setSong(await api.updateSong(song.id, { title })); }} />
      )}
      {dialog?.kind === "deleteSong" && (
        <ConfirmDialog title="Delete song" onClose={close}
          message={<>Delete <b>{song.title}</b> with all of its versions and audio? This can't be undone.</>}
          onConfirm={async () => { await api.deleteSong(song.id); navigate(parent ? `/folders/${parent.id}` : "/"); }} />
      )}
      {dialog?.kind === "renameTrack" && (
        <PromptDialog title="Rename instrument" label="Instrument" initial={dialog.track.instrument} onClose={close}
          onConfirm={async (instrument) => { await api.updateTrack(dialog.track.id, { instrument }); await reload(); }} />
      )}
      {dialog?.kind === "deleteTrack" && (
        <ConfirmDialog title="Delete track" onClose={close}
          message={<>Delete the <b>{dialog.track.instrument}</b> track from this version?</>}
          onConfirm={async () => { await api.deleteTrack(dialog.track.id); await reload(); }} />
      )}
    </div>
  );
}

/** "Move earlier/later" menu items, offered only next to a version recorded the same day. */
function sameDayMoves(versions: Version[], version: Version, move: (v: Version, step: -1 | 1) => void) {
  const i = versions.findIndex((v) => v.id === version.id);
  const day = versionDay(version);
  const items = [];
  if (versions[i - 1] && versionDay(versions[i - 1]) === day) items.push({ label: "Move earlier (left)", onClick: () => move(version, -1) });
  if (versions[i + 1] && versionDay(versions[i + 1]) === day) items.push({ label: "Move later (right)", onClick: () => move(version, 1) });
  return items;
}

function EditVersionDialog({ version, onClose, onSaved }: { version: Version; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(version.label);
  const [recordedOn, setRecordedOn] = useState(version.recorded_on ?? "");
  const [notes, setNotes] = useState(version.notes);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.updateVersion(version.id, { label: label.trim(), recorded_on: recordedOn || null, notes });
      onSaved();
      onClose();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <Modal title="Edit version" onClose={onClose} onSubmit={submit} footer={<>
      <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
      <button type="submit" className="btn primary" disabled={busy || !label.trim()}>Save</button>
    </>}>
      <label className="field"><span>Version name</span><input value={label} onChange={(e) => setLabel(e.target.value)} autoFocus /></label>
      <label className="field"><span>Recorded on</span><input type="date" value={recordedOn} onChange={(e) => setRecordedOn(e.target.value)} /></label>
      <label className="field"><span>Notes</span><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}
