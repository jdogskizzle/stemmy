from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from ..auth import current_user
from ..db import get_db
from ..models import Folder, Song, Track, Version, utcnow
from ..processing import delete_track_files, original_path
from ..schemas import (
    FolderCreate, FolderOut, FolderTreeNode, FolderUpdate, InstrumentsOut, LibraryOut, SearchOut,
    SongCreate, SongOut, SongUpdate, breadcrumbs, folder_out, song_out, song_summary,
)

router = APIRouter(prefix="/api/v1", tags=["library"], dependencies=[Depends(current_user)])

SUGGESTED_INSTRUMENTS = [
    "Vocals", "Backing Vocals", "Lead Guitar", "Rhythm Guitar", "Acoustic Guitar", "Bass",
    "Drums", "Kick", "Snare", "Overheads", "Keys", "Synth", "Percussion", "Horns", "Click", "Full Mix",
]

_folder_load = (selectinload(Folder.children), selectinload(Folder.songs))
_song_load = (selectinload(Song.versions),)


def _get_folder(db: Session, folder_id: str) -> Folder:
    folder = db.get(Folder, folder_id)
    if not folder:
        raise HTTPException(404, "Folder not found")
    return folder


def _get_song(db: Session, song_id: str) -> Song:
    song = db.get(Song, song_id)
    if not song:
        raise HTTPException(404, "Song not found")
    return song


def load_song_out(db: Session, song_id: str) -> SongOut:
    song = db.scalar(
        select(Song).where(Song.id == song_id).options(
            selectinload(Song.versions).selectinload(Version.tracks),
            selectinload(Song.versions).selectinload(Version.created_by),
        )
    )
    if not song:
        raise HTTPException(404, "Song not found")
    return song_out(song)


def _descendant_folder_ids(db: Session, root_id: str) -> list[str]:
    ids, frontier = [root_id], [root_id]
    while frontier:
        frontier = list(db.scalars(select(Folder.id).where(Folder.parent_id.in_(frontier))))
        ids.extend(frontier)
    return ids


def purge_tracks(db: Session, track_query) -> None:
    """Delete media files for the tracks matched by `track_query` (call before deleting DB rows)."""
    tracks = list(db.scalars(track_query))
    delete_track_files([t.id for t in tracks], [original_path(t) for t in tracks])


# ---------- browsing ----------

@router.get("/library", response_model=LibraryOut, summary="List a folder's contents (root when folder_id is omitted)")
def library(folder_id: str | None = Query(None), db: Session = Depends(get_db)):
    folder = _get_folder(db, folder_id) if folder_id else None
    folders = db.scalars(
        select(Folder).where(Folder.parent_id == folder_id if folder_id else Folder.parent_id.is_(None))
        .options(*_folder_load).order_by(func.lower(Folder.name))
    )
    songs = db.scalars(
        select(Song).where(Song.folder_id == folder_id if folder_id else Song.folder_id.is_(None))
        .options(*_song_load).order_by(func.lower(Song.title))
    )
    return LibraryOut(
        folder=folder_out(folder) if folder else None,
        breadcrumbs=breadcrumbs(folder),
        folders=[folder_out(f) for f in folders],
        songs=[song_summary(s) for s in songs],
    )


@router.get("/folders/tree", response_model=list[FolderTreeNode], summary="Every folder as a nested tree")
def folder_tree(db: Session = Depends(get_db)):
    rows = db.execute(select(Folder.id, Folder.name, Folder.parent_id).order_by(func.lower(Folder.name))).all()
    nodes = {r.id: FolderTreeNode(id=r.id, name=r.name, children=[]) for r in rows}
    roots: list[FolderTreeNode] = []
    for r in rows:
        (nodes[r.parent_id].children if r.parent_id in nodes else roots).append(nodes[r.id])
    return roots


@router.get("/search", response_model=SearchOut)
def search(q: str = Query(min_length=1), db: Session = Depends(get_db)):
    pattern = f"%{q.strip().lower()}%"
    folders = db.scalars(
        select(Folder).where(func.lower(Folder.name).like(pattern)).options(*_folder_load).limit(50)
    )
    songs = db.scalars(select(Song).where(func.lower(Song.title).like(pattern)).options(*_song_load).limit(50))
    return SearchOut(folders=[folder_out(f) for f in folders], songs=[song_summary(s) for s in songs])


@router.get("/instruments", response_model=InstrumentsOut)
def instruments(db: Session = Depends(get_db)):
    used = db.scalars(
        select(Track.instrument).group_by(func.lower(Track.instrument)).order_by(func.count().desc())
    ).all()
    return InstrumentsOut(suggested=SUGGESTED_INSTRUMENTS, used=list(used))


# ---------- folders ----------

@router.post("/folders", response_model=FolderOut, status_code=201)
def create_folder(body: FolderCreate, db: Session = Depends(get_db)):
    if body.parent_id:
        _get_folder(db, body.parent_id)
    folder = Folder(name=body.name.strip(), parent_id=body.parent_id)
    db.add(folder)
    db.commit()
    db.refresh(folder)
    return folder_out(folder)


@router.get("/folders/{folder_id}", response_model=FolderOut)
def get_folder(folder_id: str, db: Session = Depends(get_db)):
    return folder_out(_get_folder(db, folder_id))


@router.patch("/folders/{folder_id}", response_model=FolderOut, summary="Rename and/or move a folder")
def update_folder(folder_id: str, body: FolderUpdate, db: Session = Depends(get_db)):
    folder = _get_folder(db, folder_id)
    if body.name is not None:
        folder.name = body.name.strip()
    if "parent_id" in body.model_fields_set:
        if body.parent_id is not None:
            _get_folder(db, body.parent_id)
            if body.parent_id in _descendant_folder_ids(db, folder.id):
                raise HTTPException(400, "Can't move a folder into itself")
        folder.parent_id = body.parent_id
    db.commit()
    db.refresh(folder)
    return folder_out(folder)


@router.delete("/folders/{folder_id}", status_code=204, summary="Delete a folder and everything inside it")
def delete_folder(folder_id: str, db: Session = Depends(get_db)):
    folder = _get_folder(db, folder_id)
    folder_ids = _descendant_folder_ids(db, folder.id)
    purge_tracks(db, select(Track).join(Version).join(Song).where(Song.folder_id.in_(folder_ids)))
    db.delete(folder)
    db.commit()
    return Response(status_code=204)


# ---------- songs ----------

@router.post("/songs", response_model=SongOut, status_code=201)
def create_song(body: SongCreate, db: Session = Depends(get_db)):
    if body.folder_id:
        _get_folder(db, body.folder_id)
    song = Song(title=body.title.strip(), folder_id=body.folder_id, notes=body.notes)
    db.add(song)
    db.commit()
    return load_song_out(db, song.id)


@router.get("/songs/{song_id}", response_model=SongOut, summary="A song with every version and track")
def get_song(song_id: str, db: Session = Depends(get_db)):
    return load_song_out(db, song_id)


@router.patch("/songs/{song_id}", response_model=SongOut, summary="Rename, edit notes, or move a song")
def update_song(song_id: str, body: SongUpdate, db: Session = Depends(get_db)):
    song = _get_song(db, song_id)
    if body.title is not None:
        song.title = body.title.strip()
    if body.notes is not None:
        song.notes = body.notes
    if "folder_id" in body.model_fields_set:
        if body.folder_id is not None:
            _get_folder(db, body.folder_id)
        song.folder_id = body.folder_id
    db.commit()
    return load_song_out(db, song.id)


@router.delete("/songs/{song_id}", status_code=204)
def delete_song(song_id: str, db: Session = Depends(get_db)):
    song = _get_song(db, song_id)
    purge_tracks(db, select(Track).join(Version).where(Version.song_id == song.id))
    db.delete(song)
    db.commit()
    return Response(status_code=204)


def touch_song(db: Session, song_id: str) -> None:
    song = db.get(Song, song_id)
    if song:
        song.updated_at = utcnow()

