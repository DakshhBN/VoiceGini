import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from langchain_core.messages import HumanMessage
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import decode_ws_ticket
from app.database import AsyncSessionLocal
from app.graph import get_graph
from app.models import Thread, User
from app.stt import transcribe
from app.tts import synthesize

router = APIRouter(tags=["voice"])


async def _authenticate(websocket: WebSocket, thread_id: uuid.UUID, db: AsyncSession) -> bool:
    """Validates the ws_ticket and thread ownership before accept() - an
    invalid/missing ticket or a thread the ticket's user doesn't own gets
    the handshake rejected outright (Starlette turns a pre-accept close()
    into an HTTP-level rejection) rather than an accepted-then-closed
    connection.
    """
    ticket = websocket.query_params.get("ticket")
    user_id = decode_ws_ticket(ticket) if ticket else None
    if user_id is None:
        await websocket.close(code=4401)
        return False

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        await websocket.close(code=4401)
        return False

    result = await db.execute(select(Thread).where(Thread.id == thread_id, Thread.user_id == user.id))
    if result.scalar_one_or_none() is None:
        await websocket.close(code=4404)
        return False

    return True


@router.websocket("/ws/threads/{thread_id}/voice")
async def voice(websocket: WebSocket, thread_id: uuid.UUID) -> None:
    # A fresh session here rather than Depends(get_db) - that dependency
    # closes its session as soon as the endpoint function returns, which
    # for a WebSocket route is only after the connection ends, but opening
    # it manually keeps the pre-accept auth check and the connection's
    # lifetime obviously scoped together.
    async with AsyncSessionLocal() as db:
        if not await _authenticate(websocket, thread_id, db):
            return

        await websocket.accept()
        graph = await get_graph()
        config = {"configurable": {"thread_id": str(thread_id)}}

        try:
            while True:
                audio_bytes = await websocket.receive_bytes()

                try:
                    text = await transcribe(audio_bytes)
                except Exception:
                    await websocket.send_json({"type": "error", "detail": "Transcription failed"})
                    continue

                if not text:
                    await websocket.send_json({"type": "error", "detail": "No speech detected"})
                    continue

                await websocket.send_json({"type": "transcript", "text": text})

                input_state = {"messages": [HumanMessage(content=text)]}
                reply_text = ""
                async for chunk, _metadata in graph.astream(input_state, config, stream_mode="messages"):
                    if chunk.content:
                        reply_text += chunk.content
                        await websocket.send_json({"type": "token", "token": chunk.content})

                if reply_text.strip():
                    try:
                        audio_bytes = await synthesize(reply_text)
                    except Exception:
                        await websocket.send_json({"type": "error", "detail": "Speech synthesis failed"})
                    else:
                        # A JSON marker ahead of the raw bytes tells the
                        # client the next binary frame is audio, not a
                        # continuation of the text stream - the two share
                        # one WS connection but are distinguished by frame
                        # type (text vs binary) on the client side.
                        await websocket.send_json({"type": "audio", "format": "wav"})
                        await websocket.send_bytes(audio_bytes)

                await websocket.send_json({"type": "done"})
        except WebSocketDisconnect:
            pass
