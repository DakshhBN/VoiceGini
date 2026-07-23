import asyncio
import json
import logging
import uuid

from fastapi import APIRouter, WebSocket
from groq import RateLimitError
from langchain_core.messages import HumanMessage
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import decode_ws_ticket
from app.database import AsyncSessionLocal
from app.graph import generate_title, get_graph
from app.models import Thread, User
from app.stt import transcribe
from app.tts import synthesize

logger = logging.getLogger("app")

router = APIRouter(tags=["voice"])


async def _authenticate(websocket: WebSocket, thread_id: uuid.UUID, db: AsyncSession) -> Thread | None:
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
        return None

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        await websocket.close(code=4401)
        return None

    result = await db.execute(select(Thread).where(Thread.id == thread_id, Thread.user_id == user.id))
    thread = result.scalar_one_or_none()
    if thread is None:
        await websocket.close(code=4404)
        return None

    return thread


@router.websocket("/ws/threads/{thread_id}/voice")
async def voice(websocket: WebSocket, thread_id: uuid.UUID) -> None:
    # A fresh session here rather than Depends(get_db) - that dependency
    # closes its session as soon as the endpoint function returns, which
    # for a WebSocket route is only after the connection ends, but opening
    # it manually keeps the pre-accept auth check and the connection's
    # lifetime obviously scoped together.
    async with AsyncSessionLocal() as db:
        thread = await _authenticate(websocket, thread_id, db)
        if thread is None:
            return

        await websocket.accept()
        graph = await get_graph()
        config = {"configurable": {"thread_id": str(thread_id)}}
        # Only the first utterance of a still-untitled thread triggers a
        # title - flipped off after use so a long continuous voice session
        # doesn't regenerate it on every later utterance.
        needs_title = thread.title == "New chat"

        async def process_turn(audio_bytes: bytes) -> None:
            nonlocal needs_title
            # Runs as a cancellable Task (see cancel_current below) - this
            # is why TTS was deliberately kept out of the LangGraph node
            # back in Phase 1/3: cancelling a plain asyncio Task at any
            # await point (mid-transcription, mid-token-stream, or
            # mid-synthesis) is clean, whereas cancelling generation
            # *inside* a graph node is not. If the LLM call in chat_node
            # never completes, its superstep never checkpoints, so a
            # barge-in never leaves a half-written reply in history.
            try:
                text = await transcribe(audio_bytes)
            except Exception:
                logger.exception("Transcription failed")
                await websocket.send_json({"type": "error", "detail": "Transcription failed"})
                return

            if not text:
                await websocket.send_json({"type": "error", "detail": "No speech detected"})
                return

            await websocket.send_json({"type": "transcript", "text": text})

            if needs_title:
                needs_title = False
                try:
                    title = await generate_title(text)
                except Exception:
                    logger.exception("Thread title generation failed")
                else:
                    thread.title = title
                    await db.commit()
                    await websocket.send_json({"type": "title", "title": title})

            input_state = {"messages": [HumanMessage(content=text)]}
            reply_text = ""
            async for chunk, _metadata in graph.astream(input_state, config, stream_mode="messages"):
                if chunk.content:
                    reply_text += chunk.content
                    await websocket.send_json({"type": "token", "token": chunk.content})

            if reply_text.strip():
                try:
                    audio_bytes_out = await synthesize(reply_text)
                except RateLimitError:
                    # Groq's TTS model has a low daily token quota on the
                    # on-demand tier - this fires often enough in practice
                    # (not just as a rare edge case) that callers deserve a
                    # message that explains what actually happened rather
                    # than a generic failure.
                    logger.warning("TTS rate-limited (reply length=%d chars)", len(reply_text))
                    await websocket.send_json(
                        {"type": "error", "detail": "Voice replies are rate-limited right now - try again later"}
                    )
                except Exception:
                    logger.exception("Speech synthesis failed (reply length=%d chars)", len(reply_text))
                    await websocket.send_json({"type": "error", "detail": "Speech synthesis failed"})
                else:
                    # A JSON marker ahead of the raw bytes tells the
                    # client the next binary frame is audio, not a
                    # continuation of the text stream - the two share
                    # one WS connection but are distinguished by frame
                    # type (text vs binary) on the client side.
                    await websocket.send_json({"type": "audio", "format": "wav"})
                    await websocket.send_bytes(audio_bytes_out)

            await websocket.send_json({"type": "done"})

        current_task: asyncio.Task | None = None

        async def cancel_current() -> None:
            nonlocal current_task
            if current_task is None or current_task.done():
                current_task = None
                return
            current_task.cancel()
            try:
                await current_task
            except asyncio.CancelledError:
                pass
            current_task = None
            await websocket.send_json({"type": "interrupted"})

        try:
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    break

                audio_bytes = message.get("bytes")
                if audio_bytes is not None:
                    # A new utterance always wins - if the previous turn
                    # (still transcribing, still streaming tokens, or still
                    # synthesizing) hasn't finished, cancel it first so the
                    # two never write to the same socket concurrently.
                    await cancel_current()
                    current_task = asyncio.create_task(process_turn(audio_bytes))
                    continue

                text_data = message.get("text")
                if text_data is not None:
                    try:
                        payload = json.loads(text_data)
                    except ValueError:
                        continue
                    # The client sends this the instant its VAD detects the
                    # user has started talking again - before it even has
                    # the full new utterance to send - so playback of a
                    # stale reply can be cut as early as possible.
                    if payload.get("type") == "interrupt":
                        await cancel_current()
        finally:
            if current_task is not None and not current_task.done():
                current_task.cancel()
