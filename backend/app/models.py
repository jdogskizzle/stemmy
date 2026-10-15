import uuid
from datetime import date, datetime, timezone

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text, TypeDecorator, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def new_id() -> str:
    return uuid.uuid4().hex


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UTCDateTime(TypeDecorator):
    """Stores UTC; always returns timezone-aware datetimes (SQLite drops tzinfo)."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None and value.tzinfo is not None:
            value = value.astimezone(timezone.utc).replace(tzinfo=None)
        return value

    def process_result_value(self, value, dialect):
        return value.replace(tzinfo=timezone.utc) if value is not None else None


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Folder(Base):
    __tablename__ = "folders"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(255))
    parent_id: Mapped[str | None] = mapped_column(
        ForeignKey("folders.id", ondelete="CASCADE"), index=True, nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)

    parent: Mapped["Folder | None"] = relationship(remote_side=[id], back_populates="children")
    children: Mapped[list["Folder"]] = relationship(back_populates="parent", passive_deletes=True)
    songs: Mapped[list["Song"]] = relationship(back_populates="folder", passive_deletes=True)


class Song(Base):
    __tablename__ = "songs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    title: Mapped[str] = mapped_column(String(255))
    notes: Mapped[str] = mapped_column(Text, default="")
    folder_id: Mapped[str | None] = mapped_column(
        ForeignKey("folders.id", ondelete="CASCADE"), index=True, nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)

    folder: Mapped[Folder | None] = relationship(back_populates="songs")
    versions: Mapped[list["Version"]] = relationship(
        back_populates="song",
        passive_deletes=True,
        # Oldest first by recording day (upload day when unset); the band orders same-day versions.
        order_by=lambda: [version_day_sql(), Version.position, Version.created_at],
    )
    documents: Mapped[list["Document"]] = relationship(
        back_populates="song", passive_deletes=True, order_by=lambda: [Document.position, Document.created_at]
    )


class Version(Base):
    __tablename__ = "versions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    song_id: Mapped[str] = mapped_column(ForeignKey("songs.id", ondelete="CASCADE"), index=True)
    label: Mapped[str] = mapped_column(String(255))
    recorded_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    # Order among versions recorded on the same day (see Song.versions).
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)

    song: Mapped[Song] = relationship(back_populates="versions")
    created_by: Mapped[User | None] = relationship()
    tracks: Mapped[list["Track"]] = relationship(
        back_populates="version", passive_deletes=True, order_by=lambda: [Track.position, Track.created_at]
    )


def version_day(v: "Version") -> date:
    """The day a version sorts under: its recording date, else the (UTC) day it was uploaded."""
    return v.recorded_on or (v.created_at or utcnow()).date()


def version_day_sql():
    """SQL form of version_day (created_at is stored as naive UTC)."""
    return func.coalesce(Version.recorded_on, func.date(Version.created_at))


class Track(Base):
    __tablename__ = "tracks"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    version_id: Mapped[str] = mapped_column(ForeignKey("versions.id", ondelete="CASCADE"), index=True)
    instrument: Mapped[str] = mapped_column(String(64))
    position: Mapped[int] = mapped_column(Integer, default=0)
    original_filename: Mapped[str] = mapped_column(String(512))
    original_ext: Mapped[str] = mapped_column(String(16))
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    # pending -> processing -> ready | error
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration: Mapped[float | None] = mapped_column(Float, nullable=True)
    channels: Mapped[int | None] = mapped_column(Integer, nullable=True)
    content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    version: Mapped[Version] = relationship(back_populates="tracks")


class Document(Base):
    """A plain-text document attached to a song (lyrics, chord chart, notes...)."""

    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    song_id: Mapped[str] = mapped_column(ForeignKey("songs.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(255))
    body: Mapped[str] = mapped_column(Text, default="")
    # "text" (plain) or "markdown"
    format: Mapped[str] = mapped_column(String(16), default="text", server_default="text")
    position: Mapped[int] = mapped_column(Integer, default=0)
    # Bumped on every save; clients send it back so concurrent edits are detected instead of overwritten.
    revision: Mapped[int] = mapped_column(Integer, default=1)
    updated_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)

    song: Mapped[Song] = relationship(back_populates="documents")
    updated_by: Mapped[User | None] = relationship()
