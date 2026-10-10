from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .models import Folder, Song, Track, User, Version

API = "/api/v1"


class Model(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------- auth / users ----------

class LoginIn(BaseModel):
    username: str
    password: str


class UserOut(Model):
    id: str
    username: str
    is_admin: bool
    created_at: datetime


class TokenOut(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_at: datetime
    user: UserOut


class UserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=6, max_length=256)
    is_admin: bool = False


class UserUpdate(BaseModel):
    username: str | None = Field(None, min_length=1, max_length=64)
    is_admin: bool | None = None
    password: str | None = Field(None, min_length=6, max_length=256)


class ProfileUpdate(BaseModel):
    username: str = Field(min_length=1, max_length=64)


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=6, max_length=256)


# ---------- library ----------

class FolderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    parent_id: str | None = None


class FolderUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    parent_id: str | None = Field(None, description="Omit to leave unchanged; null moves to the root")


class FolderOut(Model):
    id: str
    name: str
    parent_id: str | None
    folder_count: int
    song_count: int
    created_at: datetime
    updated_at: datetime


class Breadcrumb(BaseModel):
    id: str
    name: str


class SongCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    folder_id: str | None = None
    notes: str = ""


class SongUpdate(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=255)
    notes: str | None = None
    folder_id: str | None = Field(None, description="Omit to leave unchanged; null moves to the root")


class SongSummary(Model):
    id: str
    title: str
    folder_id: str | None
    version_count: int
    latest_version: "VersionSummary | None"
    created_at: datetime
    updated_at: datetime


class LibraryOut(BaseModel):
    folder: FolderOut | None = Field(description="null when listing the root")
    breadcrumbs: list[Breadcrumb]
    folders: list[FolderOut]
    songs: list[SongSummary]


class FolderTreeNode(BaseModel):
    id: str
    name: str
    children: list["FolderTreeNode"]


TrackStatus = Literal["pending", "processing", "ready", "error"]


class TrackOut(Model):
    id: str
    version_id: str
    instrument: str
    position: int
    status: TrackStatus
    error: str | None
    duration: float | None
    channels: int | None
    original_filename: str
    size_bytes: int
    content_hash: str | None
    audio_url: str | None = Field(description="Streaming AAC/M4A. Immutable for a given content_hash; cache forever.")
    peaks_url: str | None = Field(description="JSON waveform peaks. Immutable for a given content_hash.")
    original_url: str
    created_at: datetime


class TrackUpdate(BaseModel):
    instrument: str | None = Field(None, min_length=1, max_length=64)
    position: int | None = None


class VersionCreate(BaseModel):
    label: str = Field(min_length=1, max_length=255)
    recorded_on: date | None = None
    notes: str = ""


class VersionUpdate(BaseModel):
    label: str | None = Field(None, min_length=1, max_length=255)
    recorded_on: date | None = None
    notes: str | None = None


class VersionSummary(Model):
    id: str
    song_id: str
    label: str
    recorded_on: date | None
    created_at: datetime


class VersionOut(Model):
    id: str
    song_id: str
    label: str
    recorded_on: date | None
    notes: str
    created_by: str | None = Field(description="Username of the uploader")
    track_count: int
    ready: bool = Field(description="True when every track has finished processing")
    duration: float | None = Field(description="Longest ready track, in seconds")
    tracks: list[TrackOut]
    created_at: datetime
    updated_at: datetime


class SongOut(Model):
    id: str
    title: str
    notes: str
    folder_id: str | None
    breadcrumbs: list[Breadcrumb]
    versions: list[VersionOut] = Field(description="Newest recording first")
    created_at: datetime
    updated_at: datetime


class InstrumentsOut(BaseModel):
    suggested: list[str]
    used: list[str] = Field(description="Instrument names already in the library, most used first")


class SearchOut(BaseModel):
    folders: list[FolderOut]
    songs: list[SongSummary]


# ---------- serializers ----------

def folder_out(f: Folder) -> FolderOut:
    return FolderOut(
        id=f.id, name=f.name, parent_id=f.parent_id,
        folder_count=len(f.children), song_count=len(f.songs),
        created_at=f.created_at, updated_at=f.updated_at,
    )


def breadcrumbs(folder: Folder | None) -> list[Breadcrumb]:
    crumbs: list[Breadcrumb] = []
    while folder is not None:
        crumbs.append(Breadcrumb(id=folder.id, name=folder.name))
        folder = folder.parent
    return list(reversed(crumbs))


def song_summary(s: Song) -> SongSummary:
    latest = s.versions[0] if s.versions else None
    return SongSummary(
        id=s.id, title=s.title, folder_id=s.folder_id, version_count=len(s.versions),
        latest_version=VersionSummary.model_validate(latest) if latest else None,
        created_at=s.created_at, updated_at=s.updated_at,
    )


def track_out(t: Track) -> TrackOut:
    ready = t.status == "ready" and t.content_hash
    return TrackOut(
        id=t.id, version_id=t.version_id, instrument=t.instrument, position=t.position,
        status=t.status, error=t.error, duration=t.duration, channels=t.channels,
        original_filename=t.original_filename, size_bytes=t.size_bytes, content_hash=t.content_hash,
        audio_url=f"{API}/tracks/{t.id}/audio?v={t.content_hash}" if ready else None,
        peaks_url=f"{API}/tracks/{t.id}/peaks?v={t.content_hash}" if ready else None,
        original_url=f"{API}/tracks/{t.id}/original",
        created_at=t.created_at,
    )


def version_out(v: Version) -> VersionOut:
    durations = [t.duration for t in v.tracks if t.status == "ready" and t.duration]
    return VersionOut(
        id=v.id, song_id=v.song_id, label=v.label, recorded_on=v.recorded_on, notes=v.notes,
        created_by=v.created_by.username if v.created_by else None,
        track_count=len(v.tracks),
        ready=bool(v.tracks) and all(t.status == "ready" for t in v.tracks),
        duration=max(durations) if durations else None,
        tracks=[track_out(t) for t in v.tracks],
        created_at=v.created_at, updated_at=v.updated_at,
    )


def song_out(s: Song) -> SongOut:
    return SongOut(
        id=s.id, title=s.title, notes=s.notes, folder_id=s.folder_id,
        breadcrumbs=breadcrumbs(s.folder),
        versions=[version_out(v) for v in s.versions],
        created_at=s.created_at, updated_at=s.updated_at,
    )


def user_out(u: User) -> UserOut:
    return UserOut.model_validate(u)


FolderTreeNode.model_rebuild()
SongSummary.model_rebuild()
