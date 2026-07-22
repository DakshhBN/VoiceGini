import asyncio

from groq import Groq

from app.config import get_settings

settings = get_settings()

# Built lazily, not at import time, so a missing/invalid GROQ_API_KEY
# doesn't crash the app at startup (same lesson as app/graph.py's get_llm).
_client: Groq | None = None


def get_client() -> Groq:
    global _client
    if _client is None:
        _client = Groq(api_key=settings.groq_api_key)
    return _client


async def transcribe(audio_bytes: bytes, filename: str = "audio.webm") -> str:
    # The Groq SDK's transcription call is synchronous (plain httpx under
    # the hood, no async client) - run it off the event loop so it doesn't
    # block other requests/connections while waiting on the network.
    def _call() -> str:
        result = get_client().audio.transcriptions.create(
            model="whisper-large-v3-turbo",
            file=(filename, audio_bytes),
            response_format="text",
        )
        return str(result).strip()

    return await asyncio.to_thread(_call)
