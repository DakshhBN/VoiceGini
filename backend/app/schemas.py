import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr


class UserCreate(BaseModel):
    email: EmailStr
    password: str


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: uuid.UUID
    email: EmailStr
    created_at: datetime

    model_config = {"from_attributes": True}


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class ThreadCreate(BaseModel):
    title: str | None = None


class ThreadUpdate(BaseModel):
    title: str


class ThreadOut(BaseModel):
    id: uuid.UUID
    title: str
    created_at: datetime

    model_config = {"from_attributes": True}


class MessageIn(BaseModel):
    content: str


class MessageOut(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class WsTicketOut(BaseModel):
    ticket: str
