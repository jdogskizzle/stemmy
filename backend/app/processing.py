"""Turns uploaded audio into a uniform streaming format plus waveform peaks.

Every track becomes 44.1 kHz AAC in an M4A container. Using the same codec and
sample rate for every stem keeps encoder delay identical across a version, so
stems stay sample-aligned after the client decodes them. Stereo uploads whose
channels are identical are stored as mono, which halves client memory once decoded.
"""

import hashlib
import json
import logging
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm.exc import StaleDataError

from . import config
from .db import SessionLocal
from .models import Track

log = logging.getLogger("stemmy.processing")
_executor = ThreadPoolExecutor(max_workers=config.PROCESSING_WORKERS, thread_name_prefix="stemmy-proc")

ANALYSIS_RATE = 22050
# Below this side/total energy ratio (about -40 dB) a stereo file is treated as mono.
MONO_THRESHOLD = 1e-4


class ProbeError(Exception):
    pass


def original_path(track: Track) -> Path:
    return config.ORIGINALS_DIR / f"{track.id}{track.original_ext}"


def stream_path(track_id: str) -> Path:
    return config.STREAM_DIR / f"{track_id}.m4a"


def peaks_path(track_id: str) -> Path:
    return config.PEAKS_DIR / f"{track_id}.json"


def probe(path: Path) -> dict:
    """Return {duration, channels, sample_rate}; raises ProbeError if the file has no audio."""
    proc = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "a:0",
            "-show_entries", "stream=channels,sample_rate:format=duration",
            "-of", "json", str(path),
        ],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        # ffprobe prefixes errors with the file path; keep only the reason.
        raise ProbeError(proc.stderr.strip().rsplit(": ", 1)[-1] or "ffprobe failed")
    info = json.loads(proc.stdout or "{}")
    streams = info.get("streams") or []
    if not streams:
        raise ProbeError("File contains no audio stream")
    duration = float((info.get("format") or {}).get("duration") or 0)
    return {
        "duration": duration,
        "channels": int(streams[0].get("channels") or 0),
        "sample_rate": int(streams[0].get("sample_rate") or 0),
    }


def analyze(path: Path, source_channels: int) -> tuple[list[float], bool, float]:
    """Stream-decode the file once, returning (peaks, is_effectively_mono, duration)."""
    bucket_frames = ANALYSIS_RATE // config.PEAKS_PER_SECOND
    bytes_per_frame = 2 * 4  # stereo float32
    chunk_bytes = bucket_frames * bytes_per_frame * 500

    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "2", "-ar", str(ANALYSIS_RATE), "-f", "f32le", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    peaks: list[np.ndarray] = []
    side_energy = 0.0
    total_energy = 0.0
    frames = 0
    leftover = b""
    assert proc.stdout is not None
    while True:
        data = proc.stdout.read(chunk_bytes)
        if not data:
            break
        data = leftover + data
        usable = len(data) - len(data) % (bucket_frames * bytes_per_frame)
        leftover = data[usable:]
        if usable:
            _accumulate(data[:usable], bucket_frames, peaks)
            side, total, n = _energy(data[:usable])
            side_energy += side
            total_energy += total
            frames += n
    if leftover:
        usable = len(leftover) - len(leftover) % bytes_per_frame
        if usable:
            tail = np.frombuffer(leftover[:usable], dtype=np.float32).reshape(-1, 2)
            peaks.append(np.array([np.abs(tail).max()], dtype=np.float32))
            side, total, n = _energy(leftover[:usable])
            side_energy += side
            total_energy += total
            frames += n
    _, stderr = proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg decode failed: {stderr.decode(errors='replace').strip()}")

    flat = np.concatenate(peaks) if peaks else np.zeros(0, dtype=np.float32)
    flat = np.clip(flat, 0.0, 1.0)
    is_mono = source_channels == 1 or total_energy == 0 or side_energy / total_energy < MONO_THRESHOLD
    return [round(float(v), 4) for v in flat], is_mono, frames / ANALYSIS_RATE


def _accumulate(buf: bytes, bucket_frames: int, out: list[np.ndarray]) -> None:
    samples = np.frombuffer(buf, dtype=np.float32).reshape(-1, bucket_frames * 2)
    out.append(np.abs(samples).max(axis=1))


def _energy(buf: bytes) -> tuple[float, float, int]:
    s = np.frombuffer(buf, dtype=np.float32).reshape(-1, 2).astype(np.float64)
    left, right = s[:, 0], s[:, 1]
    return float(np.sum((left - right) ** 2)), float(np.sum(left**2 + right**2)), len(s)


def transcode(src: Path, dest: Path, mono: bool) -> None:
    tmp = config.TMP_DIR / f"{dest.stem}.encoding.m4a"
    cmd = [
        "ffmpeg", "-v", "error", "-y", "-i", str(src),
        "-vn", "-map_metadata", "-1",
        "-ac", "1" if mono else "2",
        "-ar", str(config.STREAM_SAMPLE_RATE),
        "-c:a", "aac", "-b:a", config.STREAM_BITRATE_MONO if mono else config.STREAM_BITRATE_STEREO,
        "-movflags", "+faststart",
        str(tmp),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"ffmpeg encode failed: {proc.stderr.strip()}")
    tmp.replace(dest)


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def process_track(track_id: str) -> None:
    with SessionLocal() as db:
        track = db.get(Track, track_id)
        if track is None:
            return
        track.status = "processing"
        track.error = None
        db.commit()
        src = original_path(track)
        try:
            info = probe(src)
            peaks, is_mono, decoded_duration = analyze(src, info["channels"])
            transcode(src, stream_path(track.id), is_mono)
            peaks_path(track.id).write_text(
                json.dumps({"peaks_per_second": config.PEAKS_PER_SECOND, "length": len(peaks), "data": peaks},
                           separators=(",", ":"))
            )
            track.duration = decoded_duration or info["duration"]
            track.channels = 1 if is_mono else 2
            track.content_hash = file_hash(stream_path(track.id))
            track.status = "ready"
        except Exception as exc:  # noqa: BLE001 - surface any failure on the track
            log.exception("Processing failed for track %s", track_id)
            track.status = "error"
            track.error = str(exc)[:2000]
        try:
            db.commit()
        except StaleDataError:
            # The track was deleted while we were encoding; drop what we produced.
            db.rollback()
            delete_track_files([track_id], [])


def enqueue(track_id: str) -> None:
    _executor.submit(_safe_process, track_id)


def _safe_process(track_id: str) -> None:
    try:
        process_track(track_id)
    except Exception:  # noqa: BLE001
        log.exception("Unhandled processing error for %s", track_id)


def requeue_unfinished() -> None:
    with SessionLocal() as db:
        ids = db.scalars(select(Track.id).where(Track.status.in_(["pending", "processing"]))).all()
    for track_id in ids:
        enqueue(track_id)


def delete_track_files(track_ids: list[str], original_files: list[Path]) -> None:
    for track_id in track_ids:
        stream_path(track_id).unlink(missing_ok=True)
        peaks_path(track_id).unlink(missing_ok=True)
    for path in original_files:
        path.unlink(missing_ok=True)
