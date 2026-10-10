// Typed client for the Stemmy REST API (mirrors backend/app/schemas.py).

export interface User { id: string; username: string; is_admin: boolean; created_at: string }
export interface TokenOut { access_token: string; token_type: "bearer"; expires_at: string; user: User }
export interface Breadcrumb { id: string; name: string }
export interface Folder {
  id: string; name: string; parent_id: string | null; folder_count: number; song_count: number;
  created_at: string; updated_at: string;
}
export interface FolderNode { id: string; name: string; children: FolderNode[] }
export interface VersionSummary { id: string; song_id: string; label: string; recorded_on: string | null; created_at: string }
export interface SongSummary {
  id: string; title: string; folder_id: string | null; version_count: number;
  latest_version: VersionSummary | null; created_at: string; updated_at: string;
}
export type TrackStatus = "pending" | "processing" | "ready" | "error";
export interface Track {
  id: string; version_id: string; instrument: string; position: number; status: TrackStatus;
  error: string | null; duration: number | null; channels: number | null; original_filename: string;
  size_bytes: number; content_hash: string | null; audio_url: string | null; peaks_url: string | null;
  original_url: string; created_at: string;
}
export interface Version {
  id: string; song_id: string; label: string; recorded_on: string | null; notes: string;
  created_by: string | null; track_count: number; ready: boolean; duration: number | null;
  tracks: Track[]; created_at: string; updated_at: string;
}
export type DocumentFormat = "text" | "markdown";
export interface DocumentSummary {
  id: string; song_id: string; title: string; format: DocumentFormat; position: number; revision: number; updated_by: string | null;
  created_at: string; updated_at: string;
}
export interface SongDocument extends DocumentSummary { body: string }
export interface Song {
  id: string; title: string; notes: string; folder_id: string | null; breadcrumbs: Breadcrumb[];
  versions: Version[]; documents: DocumentSummary[]; created_at: string; updated_at: string;
}
export interface Library { folder: Folder | null; breadcrumbs: Breadcrumb[]; folders: Folder[]; songs: SongSummary[] }
export interface Peaks { peaks_per_second: number; length: number; data: number[] }

/** Path prefix the app is served under ("" at the root, "/stemmy" behind a path proxy). */
export const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Resolve a server path (as returned by the API, e.g. track.audio_url) against the base path. */
export function withBase(path: string): string {
  return path.startsWith("/") ? `${BASE_PATH}${path}` : path;
}

const TOKEN_KEY = "stemmy.token";

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable */ }
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message); }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

export function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function errorFrom(res: Response): Promise<ApiError> {
  let message = res.statusText || `HTTP ${res.status}`;
  let body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    body = await res.json();
    if (typeof body.detail === "string") message = body.detail;
    else if (Array.isArray(body.detail)) message = body.detail.map((d: { msg: string }) => d.msg).join(", ");
  } catch { /* non-JSON error */ }
  if (res.status === 401) onUnauthorized();
  return new ApiError(res.status, message, body);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(withBase(`/api/v1${path}`), {
    method,
    headers: { ...authHeaders(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await errorFrom(res);
  return res.status === 204 ? (undefined as T) : res.json();
}

const q = (params: Record<string, string | null | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null) as [string, string][]).toString();
  return s ? `?${s}` : "";
};

export const api = {
  login: (username: string, password: string) => request<TokenOut>("POST", "/auth/login", { username, password }),
  refresh: () => request<TokenOut>("POST", "/auth/refresh"),
  me: () => request<User>("GET", "/auth/me"),
  updateMe: (patch: { username: string }) => request<User>("PATCH", "/auth/me", patch),
  changePassword: (current_password: string, new_password: string) =>
    request<void>("POST", "/auth/password", { current_password, new_password }),

  users: () => request<User[]>("GET", "/users"),
  createUser: (username: string, password: string, is_admin: boolean) =>
    request<User>("POST", "/users", { username, password, is_admin }),
  updateUser: (id: string, patch: { username?: string; is_admin?: boolean; password?: string }) => request<User>("PATCH", `/users/${id}`, patch),
  deleteUser: (id: string) => request<void>("DELETE", `/users/${id}`),

  library: (folderId: string | null) => request<Library>("GET", `/library${q({ folder_id: folderId })}`),
  folderTree: () => request<FolderNode[]>("GET", "/folders/tree"),
  search: (term: string) => request<{ folders: Folder[]; songs: SongSummary[] }>("GET", `/search${q({ q: term })}`),
  instruments: () => request<{ suggested: string[]; used: string[] }>("GET", "/instruments"),

  createFolder: (name: string, parent_id: string | null) => request<Folder>("POST", "/folders", { name, parent_id }),
  updateFolder: (id: string, patch: { name?: string; parent_id?: string | null }) => request<Folder>("PATCH", `/folders/${id}`, patch),
  deleteFolder: (id: string) => request<void>("DELETE", `/folders/${id}`),

  createSong: (title: string, folder_id: string | null) => request<Song>("POST", "/songs", { title, folder_id }),
  song: (id: string) => request<Song>("GET", `/songs/${id}`),
  updateSong: (id: string, patch: { title?: string; notes?: string; folder_id?: string | null }) =>
    request<Song>("PATCH", `/songs/${id}`, patch),
  deleteSong: (id: string) => request<void>("DELETE", `/songs/${id}`),

  createVersion: (songId: string, v: { label: string; recorded_on: string | null; notes: string }) =>
    request<Version>("POST", `/songs/${songId}/versions`, v),
  updateVersion: (id: string, patch: { label?: string; recorded_on?: string | null; notes?: string }) =>
    request<Version>("PATCH", `/versions/${id}`, patch),
  deleteVersion: (id: string) => request<void>("DELETE", `/versions/${id}`),

  updateTrack: (id: string, patch: { instrument?: string; position?: number }) => request<Track>("PATCH", `/tracks/${id}`, patch),
  deleteTrack: (id: string) => request<void>("DELETE", `/tracks/${id}`),
  reprocessTrack: (id: string) => request<Track>("POST", `/tracks/${id}/reprocess`),

  document: (id: string) => request<SongDocument>("GET", `/documents/${id}`),
  createDocument: (songId: string, doc: { title: string; body?: string; format?: DocumentFormat }) =>
    request<SongDocument>("POST", `/songs/${songId}/documents`, doc),
  /** Pass `revision` to have the server reject (409, current document in `ApiError.body`) a stale save. */
  updateDocument: (id: string, patch: { title?: string; body?: string; format?: DocumentFormat; position?: number; revision?: number }) =>
    request<SongDocument>("PATCH", `/documents/${id}`, patch),
  deleteDocument: (id: string) => request<void>("DELETE", `/documents/${id}`),

  /** Multipart upload with progress (fetch can't report upload progress). */
  uploadTrack(versionId: string, file: File, instrument: string, onProgress: (fraction: number) => void,
              signal?: AbortSignal): Promise<Track> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", withBase(`/api/v1/versions/${versionId}/tracks`));
      const token = getToken();
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve(JSON.parse(xhr.responseText));
        let message = `Upload failed (${xhr.status})`;
        try { message = JSON.parse(xhr.responseText).detail ?? message; } catch { /* ignore */ }
        if (xhr.status === 401) onUnauthorized();
        reject(new ApiError(xhr.status, message));
      };
      xhr.onerror = () => reject(new ApiError(0, "Network error during upload"));
      xhr.onabort = () => reject(new ApiError(0, "Upload cancelled"));
      signal?.addEventListener("abort", () => xhr.abort());
      const form = new FormData();
      form.append("instrument", instrument);
      form.append("file", file);
      xhr.send(form);
    });
  },
};

/** Download an authenticated file (original upload) via a temporary object URL. */
export async function downloadAuthenticated(url: string, filename: string) {
  const res = await fetch(withBase(url), { headers: authHeaders() });
  if (!res.ok) throw await errorFrom(res);
  const blobUrl = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: blobUrl, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
}
