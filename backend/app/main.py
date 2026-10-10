import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import func, inspect, select, text

from . import config
from .auth import hash_password
from .db import Base, SessionLocal, engine
from .models import User
from .processing import requeue_unfinished
from .routers import documents, library, tracks, users

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("stemmy")


def _bootstrap_admin() -> None:
    with SessionLocal() as db:
        if db.scalar(select(func.count()).select_from(User)):
            return
        password = config.ADMIN_PASSWORD
        if not password:
            log.warning("No users exist and STEMMY_ADMIN_PASSWORD is not set; no admin account created.")
            return
        db.add(User(username=config.ADMIN_USERNAME, password_hash=hash_password(password), is_admin=True))
        db.commit()
        log.info("Created admin user '%s'", config.ADMIN_USERNAME)


def _migrate() -> None:
    """Add columns introduced after a table was first created (create_all only creates missing tables)."""
    added = {"documents": {"format": "VARCHAR(16) NOT NULL DEFAULT 'text'"}}
    with engine.begin() as conn:
        insp = inspect(conn)
        for table, columns in added.items():
            existing = {c["name"] for c in insp.get_columns(table)}
            for name, ddl in columns.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
                    log.info("Added column %s.%s", table, name)


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(engine)
    _migrate()
    _bootstrap_admin()
    requeue_unfinished()
    yield


app = FastAPI(
    title="Stemmy API",
    version="1.0.0",
    description=(
        "Self-hosted multitrack practice server.\n\n"
        "Authenticate with `POST /api/v1/auth/login` and send `Authorization: Bearer <token>`. "
        "Media endpoints also accept `?access_token=` for players that can't set headers.\n\n"
        "Hierarchy: folders → songs → versions (one per recording date) → tracks (one per instrument)."
    ),
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
    root_path=config.ROOT_PATH,
)

app.include_router(users.router)
app.include_router(library.router)
app.include_router(tracks.router)
app.include_router(tracks.media)
app.include_router(documents.router)


@app.get("/api/health", tags=["meta"])
def health():
    return {"status": "ok"}
