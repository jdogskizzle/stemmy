import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Folder, type Library, type SongSummary } from "../api";
import { Menu } from "../components/Menu";
import { ConfirmDialog, PromptDialog } from "../components/Modal";
import { MoveDialog } from "../components/MoveDialog";
import { formatDate } from "../util";

type Dialog =
  | { kind: "newFolder" } | { kind: "newSong" }
  | { kind: "renameFolder"; folder: Folder } | { kind: "moveFolder"; folder: Folder } | { kind: "deleteFolder"; folder: Folder }
  | { kind: "renameSong"; song: SongSummary } | { kind: "moveSong"; song: SongSummary } | { kind: "deleteSong"; song: SongSummary };

export default function LibraryPage() {
  const { folderId = null } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<Library | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ folders: Folder[]; songs: SongSummary[] } | null>(null);

  const reload = useCallback(() => {
    api.library(folderId).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  }, [folderId]);
  useEffect(reload, [reload]);

  useEffect(() => {
    if (!query.trim()) { setResults(null); return; }
    const t = setTimeout(() => api.search(query).then(setResults).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [query]);

  const close = () => setDialog(null);
  const folders = results?.folders ?? data?.folders ?? [];
  const songs = results?.songs ?? data?.songs ?? [];

  return (
    <div className="page">
      <nav className="crumbs">
        <Link to="/">Library</Link>
        {data?.breadcrumbs.map((c) => (
          <span key={c.id}><span className="sep">/</span><Link to={`/folders/${c.id}`}>{c.name}</Link></span>
        ))}
      </nav>
      <div className="page-head">
        <h1>{data?.folder?.name ?? "Library"}</h1>
        <div className="row gap">
          <input className="search" type="search" placeholder="Search songs & folders" value={query}
            onChange={(e) => setQuery(e.target.value)} />
          <button className="btn" onClick={() => setDialog({ kind: "newFolder" })}>New folder</button>
          <button className="btn primary" onClick={() => setDialog({ kind: "newSong" })}>New song</button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {!data && !error && <div className="spinner" />}

      {data && folders.length === 0 && songs.length === 0 && (
        <div className="empty">
          {results ? <p>No matches for “{query}”.</p> : <>
            <p>This folder is empty.</p>
            <p className="muted">Create a folder to organize a setlist or album, or add a song to start uploading stems.</p>
          </>}
        </div>
      )}

      {folders.length > 0 && (
        <section>
          <h3 className="section-label">Folders</h3>
          <div className="grid">
            {folders.map((f) => (
              <Link key={f.id} to={`/folders/${f.id}`} className="card folder-card">
                <span className="folder-icon">📁</span>
                <span className="card-main">
                  <span className="card-title">{f.name}</span>
                  <span className="muted small">
                    {[f.folder_count && `${f.folder_count} folder${f.folder_count === 1 ? "" : "s"}`,
                      `${f.song_count} song${f.song_count === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <Menu items={[
                  { label: "Rename", onClick: () => setDialog({ kind: "renameFolder", folder: f }) },
                  { label: "Move…", onClick: () => setDialog({ kind: "moveFolder", folder: f }) },
                  { label: "Delete", danger: true, onClick: () => setDialog({ kind: "deleteFolder", folder: f }) },
                ]} />
              </Link>
            ))}
          </div>
        </section>
      )}

      {songs.length > 0 && (
        <section>
          <h3 className="section-label">Songs</h3>
          <div className="list">
            {songs.map((s) => (
              <Link key={s.id} to={`/songs/${s.id}`} className="list-row">
                <span className="song-icon">♪</span>
                <span className="card-main">
                  <span className="card-title">{s.title}</span>
                  <span className="muted small">
                    {s.version_count === 0 ? "No versions yet" : `${s.version_count} version${s.version_count === 1 ? "" : "s"}`}
                    {s.latest_version && ` · latest ${s.latest_version.label}${s.latest_version.recorded_on ? ` (${formatDate(s.latest_version.recorded_on)})` : ""}`}
                  </span>
                </span>
                <Menu items={[
                  { label: "Rename", onClick: () => setDialog({ kind: "renameSong", song: s }) },
                  { label: "Move…", onClick: () => setDialog({ kind: "moveSong", song: s }) },
                  { label: "Delete", danger: true, onClick: () => setDialog({ kind: "deleteSong", song: s }) },
                ]} />
              </Link>
            ))}
          </div>
        </section>
      )}

      {dialog?.kind === "newFolder" && (
        <PromptDialog title="New folder" label="Name" confirmLabel="Create" onClose={close}
          onConfirm={async (name) => { await api.createFolder(name, folderId); reload(); }} />
      )}
      {dialog?.kind === "newSong" && (
        <PromptDialog title="New song" label="Title" confirmLabel="Create" onClose={close}
          onConfirm={async (title) => { const s = await api.createSong(title, folderId); navigate(`/songs/${s.id}?upload=1`); }} />
      )}
      {dialog?.kind === "renameFolder" && (
        <PromptDialog title="Rename folder" label="Name" initial={dialog.folder.name} onClose={close}
          onConfirm={async (name) => { await api.updateFolder(dialog.folder.id, { name }); reload(); }} />
      )}
      {dialog?.kind === "moveFolder" && (
        <MoveDialog title={`Move “${dialog.folder.name}”`} currentParentId={dialog.folder.parent_id}
          excludeId={dialog.folder.id} onClose={close}
          onConfirm={async (parent_id) => { await api.updateFolder(dialog.folder.id, { parent_id }); reload(); }} />
      )}
      {dialog?.kind === "deleteFolder" && (
        <ConfirmDialog title="Delete folder" onClose={close}
          message={<>Delete <b>{dialog.folder.name}</b> and <b>everything inside it</b> (subfolders, songs, and all uploaded audio)? This can't be undone.</>}
          onConfirm={async () => { await api.deleteFolder(dialog.folder.id); reload(); }} />
      )}
      {dialog?.kind === "renameSong" && (
        <PromptDialog title="Rename song" label="Title" initial={dialog.song.title} onClose={close}
          onConfirm={async (title) => { await api.updateSong(dialog.song.id, { title }); reload(); }} />
      )}
      {dialog?.kind === "moveSong" && (
        <MoveDialog title={`Move “${dialog.song.title}”`} currentParentId={dialog.song.folder_id} onClose={close}
          onConfirm={async (folder_id) => { await api.updateSong(dialog.song.id, { folder_id }); reload(); }} />
      )}
      {dialog?.kind === "deleteSong" && (
        <ConfirmDialog title="Delete song" onClose={close}
          message={<>Delete <b>{dialog.song.title}</b> with all of its versions and audio? This can't be undone.</>}
          onConfirm={async () => { await api.deleteSong(dialog.song.id); reload(); }} />
      )}
    </div>
  );
}
