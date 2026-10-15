import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import config
from ..auth import current_user, current_user_media
from ..db import get_db
from ..models import Song, Track, User, Version, new_id, version_day
from ..processing import ProbeError, enqueue, original_path, peaks_path, probe, stream_path
from ..schemas import TrackOut, TrackUpdate, VersionCreate, VersionOrder, VersionOut, VersionUpdate, track_out, version_out
from .library import purge_tracks, touch_song

router = APIRouter(prefix="/api/v1", tags=["versions & tracks"])
media = APIRouter(prefix="/api/v1", tags=["media"], dependencies=[Depends(current_user_media)])

IMMUTABLE = "private, max-age=31536000, immutable"
REVALIDATE = "private, no-cache"


def _get_version(db: Session, version_id: str) -> Version:
    version = db.get(Version, version_id)
    if not version:
        raise HTTPException(404, "Version not found")
    return version


def _get_track(db: Session, track_id: str) -> Track:
    track = db.get(Track, track_id)
    if not track:
        raise HTTPException(404, "Track not found")
    return track


# ---------- versions ----------

def _next_position(song: Song, day, exclude: Version | None = None) -> int:
    """Position that puts a version after every other version of `song` on `day`."""
    same_day = [v.position for v in song.versions if v is not exclude and version_day(v) == day]
    return max(same_day, default=-1) + 1


@router.post("/songs/{song_id}/versions", response_model=VersionOut, status_code=201,
             summary="Create an (empty) version; then upload one track per instrument to it")
def create_version(song_id: str, body: VersionCreate, user: User = Depends(current_user), db: Session = Depends(get_db)):
    song = db.get(Song, song_id)
    if not song:
        raise HTTPException(404, "Song not found")
    version = Version(song_id=song_id, label=body.label.strip(), recorded_on=body.recorded_on,
                      notes=body.notes, created_by_id=user.id)
    version.position = _next_position(song, version_day(version))
    db.add(version)
    touch_song(db, song_id)
    db.commit()
    return version_out(version)


@router.put("/songs/{song_id}/versions/order", status_code=204, dependencies=[Depends(current_user)],
            summary="Set the order of a song's versions; only the order within each recording day takes effect")
def order_versions(song_id: str, body: VersionOrder, db: Session = Depends(get_db)):
    song = db.get(Song, song_id)
    if not song:
        raise HTTPException(404, "Song not found")
    by_id = {v.id: v for v in song.versions}
    if sorted(body.version_ids) != sorted(by_id):
        raise HTTPException(400, "version_ids must list every version of the song exactly once")
    for i, version_id in enumerate(body.version_ids):
        by_id[version_id].position = i
    touch_song(db, song_id)
    db.commit()
    return Response(status_code=204)


@router.get("/versions/{version_id}", response_model=VersionOut, dependencies=[Depends(current_user)])
def get_version(version_id: str, db: Session = Depends(get_db)):
    return version_out(_get_version(db, version_id))


@router.patch("/versions/{version_id}", response_model=VersionOut, dependencies=[Depends(current_user)])
def update_version(version_id: str, body: VersionUpdate, db: Session = Depends(get_db)):
    version = _get_version(db, version_id)
    if body.label is not None:
        version.label = body.label.strip()
    if "recorded_on" in body.model_fields_set and body.recorded_on != version.recorded_on:
        old_day = version_day(version)
        version.recorded_on = body.recorded_on
        if version_day(version) != old_day:  # moved to another day: goes after that day's versions
            version.position = _next_position(version.song, version_day(version), exclude=version)
    if body.notes is not None:
        version.notes = body.notes
    db.commit()
    return version_out(version)


@router.delete("/versions/{version_id}", status_code=204, dependencies=[Depends(current_user)])
def delete_version(version_id: str, db: Session = Depends(get_db)):
    version = _get_version(db, version_id)
    purge_tracks(db, select(Track).where(Track.version_id == version.id))
    db.delete(version)
    db.commit()
    return Response(status_code=204)


# ---------- tracks ----------

def _save_upload(upload: UploadFile, dest: Path) -> int:
    limit = config.MAX_UPLOAD_MB * 1024 * 1024
    written = 0
    with dest.open("wb") as out:
        while chunk := upload.file.read(1 << 20):
            written += len(chunk)
            if written > limit:
                raise HTTPException(413, f"File exceeds {config.MAX_UPLOAD_MB} MB limit")
            out.write(chunk)
    return written


@router.post("/versions/{version_id}/tracks", response_model=TrackOut, status_code=201,
             dependencies=[Depends(current_user)],
             summary="Upload one instrument's audio file (multipart). Processing happens in the background.")
async def upload_track(
    version_id: str,
    file: UploadFile = File(...),
    instrument: str = Form(..., min_length=1, max_length=64),
    position: int | None = Form(None),
    db: Session = Depends(get_db),
):
    version = _get_version(db, version_id)
    filename = Path(file.filename or "upload").name
    ext = Path(filename).suffix.lower()[:16] or ".bin"
    if position is None:
        position = (db.scalar(select(func.max(Track.position)).where(Track.version_id == version.id)) or 0) + 1

    # Write the file before touching the DB so a slow upload never holds SQLite's write lock.
    track = Track(id=new_id(), version_id=version.id, instrument=instrument.strip(), position=position,
                  original_filename=filename, original_ext=ext)
    dest = original_path(track)
    try:
        track.size_bytes = await run_in_threadpool(_save_upload, file, dest)
        await run_in_threadpool(probe, dest)
    except ProbeError as exc:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, f"'{filename}' isn't a readable audio file: {exc}")
    except BaseException:
        dest.unlink(missing_ok=True)
        raise
    db.add(track)
    touch_song(db, version.song_id)
    db.commit()
    enqueue(track.id)
    return track_out(track)


@router.get("/tracks/{track_id}", response_model=TrackOut, dependencies=[Depends(current_user)])
def get_track(track_id: str, db: Session = Depends(get_db)):
    return track_out(_get_track(db, track_id))


@router.patch("/tracks/{track_id}", response_model=TrackOut, dependencies=[Depends(current_user)])
def update_track(track_id: str, body: TrackUpdate, db: Session = Depends(get_db)):
    track = _get_track(db, track_id)
    if body.instrument is not None:
        track.instrument = body.instrument.strip()
    if body.position is not None:
        track.position = body.position
    db.commit()
    return track_out(track)


@router.delete("/tracks/{track_id}", status_code=204, dependencies=[Depends(current_user)])
def delete_track(track_id: str, db: Session = Depends(get_db)):
    track = _get_track(db, track_id)
    purge_tracks(db, select(Track).where(Track.id == track.id))
    db.delete(track)
    db.commit()
    return Response(status_code=204)


@router.post("/tracks/{track_id}/reprocess", response_model=TrackOut, dependencies=[Depends(current_user)])
def reprocess_track(track_id: str, db: Session = Depends(get_db)):
    track = _get_track(db, track_id)
    track.status = "pending"
    track.error = None
    db.commit()
    enqueue(track.id)
    return track_out(track)


# ---------- media ----------

def _ready_track(db: Session, track_id: str) -> Track:
    track = _get_track(db, track_id)
    if track.status != "ready":
        raise HTTPException(409, f"Track is {track.status}")
    return track


@media.get("/tracks/{track_id}/audio", response_class=FileResponse,
           summary="Stream-ready AAC (audio/mp4). Supports Range requests.")
def track_audio(track_id: str, v: str | None = Query(None), db: Session = Depends(get_db)):
    track = _ready_track(db, track_id)
    return FileResponse(stream_path(track.id), media_type="audio/mp4",
                        headers={"Cache-Control": IMMUTABLE if v == track.content_hash else REVALIDATE})


@media.get("/tracks/{track_id}/peaks", response_class=FileResponse,
           summary="Waveform peaks: {peaks_per_second, length, data: [0..1]}")
def track_peaks(track_id: str, v: str | None = Query(None), db: Session = Depends(get_db)):
    track = _ready_track(db, track_id)
    return FileResponse(peaks_path(track.id), media_type="application/json",
                        headers={"Cache-Control": IMMUTABLE if v == track.content_hash else REVALIDATE})


@media.get("/tracks/{track_id}/original", response_class=FileResponse, summary="Download the file as uploaded")
def track_original(track_id: str, db: Session = Depends(get_db)):
    track = _get_track(db, track_id)
    return FileResponse(original_path(track), filename=track.original_filename,
                        headers={"Cache-Control": REVALIDATE})
