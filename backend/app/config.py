import os
import secrets
from pathlib import Path

DATA_DIR = Path(os.environ.get("STEMMY_DATA_DIR", "/data"))
MEDIA_DIR = DATA_DIR / "media"
ORIGINALS_DIR = MEDIA_DIR / "originals"
STREAM_DIR = MEDIA_DIR / "stream"
PEAKS_DIR = MEDIA_DIR / "peaks"
TMP_DIR = MEDIA_DIR / "tmp"

# Path prefix when served behind a path-based reverse proxy (e.g. "/stemmy"); the proxy strips it.
ROOT_PATH = os.environ.get("STEMMY_BASE_PATH", "").rstrip("/")

DATABASE_URL = os.environ.get("STEMMY_DATABASE_URL", f"sqlite:///{DATA_DIR / 'stemmy.db'}")

ADMIN_USERNAME = os.environ.get("STEMMY_ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("STEMMY_ADMIN_PASSWORD", "")

TOKEN_TTL_DAYS = int(os.environ.get("STEMMY_TOKEN_TTL_DAYS", "30"))
MAX_UPLOAD_MB = int(os.environ.get("STEMMY_MAX_UPLOAD_MB", "1024"))
PROCESSING_WORKERS = int(os.environ.get("STEMMY_PROCESSING_WORKERS", "2"))

# Every stream file is encoded identically (same codec, sample rate, encoder delay),
# which keeps stems of one version sample-aligned once decoded by the client.
STREAM_SAMPLE_RATE = 44100
STREAM_BITRATE_STEREO = os.environ.get("STEMMY_STREAM_BITRATE", "192k")
STREAM_BITRATE_MONO = os.environ.get("STEMMY_STREAM_BITRATE_MONO", "128k")
PEAKS_PER_SECOND = 50

for d in (DATA_DIR, ORIGINALS_DIR, STREAM_DIR, PEAKS_DIR, TMP_DIR):
    d.mkdir(parents=True, exist_ok=True)


def _load_secret_key() -> str:
    env = os.environ.get("STEMMY_SECRET_KEY")
    if env:
        return env
    path = DATA_DIR / "secret_key"
    if path.exists():
        return path.read_text().strip()
    key = secrets.token_urlsafe(48)
    path.write_text(key)
    path.chmod(0o600)
    return key


SECRET_KEY = _load_secret_key()
