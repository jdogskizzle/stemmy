import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import func, select

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


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(engine)
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
