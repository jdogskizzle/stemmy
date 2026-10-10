from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import current_user
from ..db import get_db
from ..models import Document, Song, User
from ..schemas import DocumentCreate, DocumentOut, DocumentSummary, DocumentUpdate, document_out, document_summary
from .library import touch_song

router = APIRouter(prefix="/api/v1", tags=["documents"])


def _get_document(db: Session, document_id: str) -> Document:
    doc = db.get(Document, document_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    return doc


@router.get("/songs/{song_id}/documents", response_model=list[DocumentSummary], dependencies=[Depends(current_user)])
def list_documents(song_id: str, db: Session = Depends(get_db)):
    song = db.get(Song, song_id)
    if not song:
        raise HTTPException(404, "Song not found")
    return [document_summary(d) for d in song.documents]


@router.post("/songs/{song_id}/documents", response_model=DocumentOut, status_code=201,
             summary="Create a text document (lyrics, chords, notes...) for a song")
def create_document(song_id: str, body: DocumentCreate, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not db.get(Song, song_id):
        raise HTTPException(404, "Song not found")
    last = db.scalar(select(func.max(Document.position)).where(Document.song_id == song_id))
    doc = Document(song_id=song_id, title=body.title.strip(), body=body.body,
                   position=(last + 1) if last is not None else 0, updated_by_id=user.id)
    db.add(doc)
    touch_song(db, song_id)
    db.commit()
    return document_out(doc)


@router.get("/documents/{document_id}", response_model=DocumentOut, dependencies=[Depends(current_user)])
def get_document(document_id: str, db: Session = Depends(get_db)):
    return document_out(_get_document(db, document_id))


@router.patch("/documents/{document_id}", response_model=DocumentOut,
              responses={409: {"model": DocumentOut, "description": "Someone else saved first; the current document"}})
def update_document(document_id: str, body: DocumentUpdate, user: User = Depends(current_user), db: Session = Depends(get_db)):
    doc = _get_document(db, document_id)
    if body.revision is not None and body.revision != doc.revision:
        return JSONResponse(document_out(doc).model_dump(mode="json"), status_code=409)
    if body.title is not None:
        doc.title = body.title.strip()
    if body.position is not None:
        doc.position = body.position
    if body.body is not None and body.body != doc.body:
        doc.body = body.body
        doc.revision += 1
    if db.is_modified(doc):
        doc.updated_by_id = user.id
        touch_song(db, doc.song_id)
    db.commit()
    return document_out(doc)


@router.delete("/documents/{document_id}", status_code=204, dependencies=[Depends(current_user)])
def delete_document(document_id: str, db: Session = Depends(get_db)):
    doc = _get_document(db, document_id)
    touch_song(db, doc.song_id)
    db.delete(doc)
    db.commit()
    return Response(status_code=204)
