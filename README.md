# Stemmy

A self-hosted multitrack player for band practice. Organize songs in folders, upload each recording as separate
instrument stems, flip between versions recorded on different dates, and mute or solo any instrument instantly.

- **Folders → Songs → Versions → Tracks.** Folders nest. A version is one recording (e.g. "10/5 practice"),
  and a track is one instrument's stem in that recording. Versions run oldest to newest, left to right, and a
  song opens on the newest; versions recorded the same day can be put in order from the version menu.
- **Instant mute/solo.** All stems are decoded in the browser and started on the same audio-clock sample, so they
  stay locked together. Mute, solo and volume only change gain, so toggling never stalls or drifts.
- **Seamless version switching.** The current version keeps playing while the next one loads, then playback
  hands over at the same position. Mute/solo/volume settings follow the instrument name, so if bass is soloed
  it stays soloed.
- **Waveforms.** Each stem gets a lane, and a mix waveform at the top reflects whatever is currently audible.
  Click to seek, or drag to set an A–B loop (the loop is gapless).
- **Lyrics & notes.** Each song can hold documents (lyrics, chord charts, set notes), in plain text or Markdown
  (with tables), with an autosaving editor, `.txt`/`.md` import and download, and a monospace mode for lining
  chords up over lyrics. Markdown exported from Google Docs imports directly (embedded images are dropped).
  If two people edit the same document, the second save is flagged instead of silently overwriting the first.
- **Caching.** Media URLs carry a content hash and are served `immutable`. The browser keeps encoded audio in the
  Cache API (persists across visits), decoded audio in a memory-bounded LRU (the current version is pinned), and
  prefetches other recent versions in the background.
- **API-first.** Everything goes through a versioned REST API (`/api/v1`) with OpenAPI docs at `/api/docs`, ready
  for a future phone app.

## Running it

```bash
cp .env.example .env      # set STEMMY_ADMIN_PASSWORD at minimum
docker compose up -d --build
```

Open `http://<server-ip>/` and sign in as the admin. Add bandmates under **Settings → Band members**.

### HTTPS / remote access

Set `SITE_ADDRESS` in `.env` to a domain name (e.g. `music.example.com`) and Caddy obtains and renews a Let's Encrypt
certificate automatically. This requires:

1. A DNS A/AAAA record for the domain pointing at your public IP (a dynamic DNS name works too).
2. Ports **80** and **443** on your router forwarded to this server.

If you'd rather not open ports, keep `SITE_ADDRESS=:80` and put Stemmy behind a Cloudflare Tunnel or Tailscale
(Funnel/Serve). Either one terminates TLS for you.

> Browser-side persistent caching (Cache API) only works in a secure context (HTTPS or `localhost`). On plain HTTP
> over the LAN, playback still works and relies on the regular HTTP cache instead.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `STEMMY_ADMIN_USERNAME` / `STEMMY_ADMIN_PASSWORD` | `admin` / — | Admin created on first start (only if there are no users) |
| `STEMMY_DATA_DIR` | `./data` | Database, uploaded originals, stream files, waveform peaks |
| `PUID` / `PGID` | `1000` | Owner of the data directory |
| `SITE_ADDRESS` | `:80` | `:80` for HTTP, or a domain for automatic HTTPS |
| `HTTP_PORT` / `HTTPS_PORT` | `80` / `443` | Host ports |
| `STEMMY_BASE_PATH` | — | Serve under a sub-path (e.g. `/stemmy`) behind a path-routing proxy that strips the prefix; set `SITE_ADDRESS=:80` and let that proxy handle HTTPS |
| `STEMMY_TOKEN_TTL_DAYS` | `30` | Login lifetime (refreshed on each app start) |
| `STEMMY_MAX_UPLOAD_MB` | `1024` | Per-file upload limit |

Back up the data directory to back up everything. `data/secret_key` signs login tokens; if you delete it, everyone
has to sign in again.

## How audio is processed

Uploads are kept untouched (downloadable from a track's menu). A background worker then:

1. Decodes the file once to compute waveform peaks (50 per second) and to detect "fake stereo" (identical L/R).
2. Encodes a streaming copy as 44.1 kHz AAC (192 kbps stereo, or 128 kbps mono for fake-stereo/mono sources).
   Every stem uses identical encoder settings, so encoder delay is the same across a version and stems stay aligned.
   Storing fake-stereo as mono halves the browser's memory use for that stem.

Stems should all start at the same moment (export them from the same session start point), just as a DAW would
expect.

## API overview

Auth: `POST /api/v1/auth/login` → `{access_token, expires_at, user}`. Send `Authorization: Bearer <token>`.
Media endpoints also accept `?access_token=` for native players that can't set headers.

| | |
|---|---|
| `GET/PATCH /api/v1/auth/me` | Your account; PATCH `{username}` to rename yourself |
| `GET /api/v1/library?folder_id=` | Folder contents (root if omitted): `{folder, breadcrumbs, folders, songs}` |
| `GET /api/v1/folders/tree` | All folders as a nested tree |
| `POST/PATCH/DELETE /api/v1/folders[/{id}]` | Create, rename/move (`parent_id: null` = root), delete recursively |
| `POST/GET/PATCH/DELETE /api/v1/songs[/{id}]` | Song with every version and track embedded |
| `POST /api/v1/songs/{id}/versions` | Create a version `{label, recorded_on, notes}` |
| `PUT /api/v1/songs/{id}/versions/order` | `{version_ids}` in display order; sets the order of same-day versions |
| `POST /api/v1/versions/{id}/tracks` | Multipart upload: `file` + `instrument` (processed in the background) |
| `POST /api/v1/songs/{id}/documents` | Create a document `{title, body, format: "text" \| "markdown"}` |
| `GET/PATCH/DELETE /api/v1/documents/{id}` | Read, edit `{title, body, format, position, revision}`, delete. A stale `revision` gets 409 + the current document |
| `GET /api/v1/tracks/{id}/audio?v=hash` | Streaming AAC, Range-capable, immutable per hash |
| `GET /api/v1/tracks/{id}/peaks?v=hash` | `{peaks_per_second, length, data}` |
| `GET /api/v1/tracks/{id}/original` | Original upload |
| `GET /api/v1/instruments`, `GET /api/v1/search?q=` | Instrument suggestions, search |

A track's `status` moves `pending → processing → ready | error`. Clients poll the song or version until
tracks are `ready`. All IDs are opaque strings, and all timestamps are ISO-8601 UTC.

## Development

```bash
# backend (needs ffmpeg on PATH)
cd backend && pip install -r requirements.txt
STEMMY_DATA_DIR=./devdata STEMMY_ADMIN_PASSWORD=dev uvicorn app.main:app --reload

# frontend (proxies /api to localhost:8000)
cd frontend && npm install && npm run dev
```

The schema is created automatically with `create_all`. Add Alembic before making breaking model changes to a
database that holds real data.
