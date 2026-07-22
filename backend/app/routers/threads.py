import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from langchain_core.messages import HumanMessage
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.database import get_db
from app.graph import get_graph
from app.models import Thread, User
from app.schemas import MessageIn, MessageOut, ThreadCreate, ThreadOut

router = APIRouter(prefix="/threads", tags=["threads"])


async def _get_owned_thread(thread_id: uuid.UUID, db: AsyncSession, user: User) -> Thread:
    result = await db.execute(select(Thread).where(Thread.id == thread_id, Thread.user_id == user.id))
    thread = result.scalar_one_or_none()
    if thread is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Thread not found")
    return thread


@router.post("", response_model=ThreadOut, status_code=status.HTTP_201_CREATED)
async def create_thread(
    payload: ThreadCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Thread:
    thread = Thread(user_id=user.id, title=payload.title or "New chat")
    db.add(thread)
    await db.commit()
    await db.refresh(thread)
    return thread


@router.get("", response_model=list[ThreadOut])
async def list_threads(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[Thread]:
    result = await db.execute(select(Thread).where(Thread.user_id == user.id).order_by(Thread.created_at.desc()))
    return list(result.scalars())


@router.get("/{thread_id}/messages", response_model=list[MessageOut])
async def get_messages(
    thread_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[MessageOut]:
    await _get_owned_thread(thread_id, db, user)

    graph = await get_graph()
    state = await graph.aget_state({"configurable": {"thread_id": str(thread_id)}})
    messages = state.values.get("messages", [])
    return [
        MessageOut(role="user" if m.type == "human" else "assistant", content=m.content) for m in messages
    ]


@router.post("/{thread_id}/chat")
async def chat(
    thread_id: uuid.UUID,
    payload: MessageIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StreamingResponse:
    # Ownership check happens here, before the graph is touched - the
    # graph itself has no user concept, only an opaque thread_id.
    await _get_owned_thread(thread_id, db, user)

    graph = await get_graph()
    config = {"configurable": {"thread_id": str(thread_id)}}
    input_state = {"messages": [HumanMessage(content=payload.content)]}

    async def event_stream():
        async for chunk, _metadata in graph.astream(input_state, config, stream_mode="messages"):
            if chunk.content:
                yield f"data: {json.dumps({'token': chunk.content})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
