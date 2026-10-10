from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import admin_user, create_token, current_user, hash_password, verify_password
from ..db import get_db
from ..models import User
from ..schemas import LoginIn, PasswordChange, ProfileUpdate, TokenOut, UserCreate, UserOut, UserUpdate, user_out

router = APIRouter(prefix="/api/v1", tags=["auth & users"])


def _username_taken(db: Session, username: str, exclude_id: str | None = None) -> bool:
    query = select(User.id).where(func.lower(User.username) == username.lower())
    if exclude_id:
        query = query.where(User.id != exclude_id)
    return db.scalar(query) is not None


def _set_username(db: Session, user: User, raw: str) -> None:
    username = raw.strip()
    if not username:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Username can't be blank")
    if _username_taken(db, username, exclude_id=user.id):
        raise HTTPException(status.HTTP_409_CONFLICT, "Username already taken")
    user.username = username


@router.post("/auth/login", response_model=TokenOut)
def login(body: LoginIn, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(func.lower(User.username) == body.username.strip().lower()))
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect username or password")
    token, expires = create_token(user)
    return TokenOut(access_token=token, expires_at=expires, user=user_out(user))


@router.post("/auth/refresh", response_model=TokenOut, summary="Exchange a valid token for a fresh one")
def refresh(user: User = Depends(current_user)):
    token, expires = create_token(user)
    return TokenOut(access_token=token, expires_at=expires, user=user_out(user))


@router.get("/auth/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return user_out(user)


@router.patch("/auth/me", response_model=UserOut, summary="Update your own profile (username)")
def update_me(body: ProfileUpdate, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _set_username(db, user, body.username)
    db.commit()
    return user_out(user)


@router.post("/auth/password", status_code=204)
def change_password(body: PasswordChange, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is incorrect")
    user.password_hash = hash_password(body.new_password)
    db.commit()
    return Response(status_code=204)


@router.get("/users", response_model=list[UserOut])
def list_users(_: User = Depends(current_user), db: Session = Depends(get_db)):
    return [user_out(u) for u in db.scalars(select(User).order_by(User.username))]


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(body: UserCreate, _: User = Depends(admin_user), db: Session = Depends(get_db)):
    username = body.username.strip()
    if not username:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Username can't be blank")
    if _username_taken(db, username):
        raise HTTPException(status.HTTP_409_CONFLICT, "Username already taken")
    user = User(username=username, password_hash=hash_password(body.password), is_admin=body.is_admin)
    db.add(user)
    db.commit()
    return user_out(user)


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(user_id: str, body: UserUpdate, admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    if body.username is not None:
        _set_username(db, user, body.username)
    if body.is_admin is not None:
        if user.id == admin.id and not body.is_admin:
            raise HTTPException(400, "You can't remove your own admin rights")
        user.is_admin = body.is_admin
    if body.password:
        user.password_hash = hash_password(body.password)
    db.commit()
    return user_out(user)


@router.delete("/users/{user_id}", status_code=204)
def delete_user(user_id: str, admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    if user_id == admin.id:
        raise HTTPException(400, "You can't delete yourself")
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    db.delete(user)
    db.commit()
    return Response(status_code=204)
