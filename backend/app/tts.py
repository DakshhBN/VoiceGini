import asyncio

from groq import Groq

from app.config import get_settings
from app.usage import log_tts_usage

settings = get_settings()

# Built lazily, not at import time, so a missing/invalid GROQ_API_KEY
# doesn't crash the app at startup (same lesson as app/graph.py's get_llm).
_client: Groq | None = None

# playai-tts (the model this project's README originally named) was
# decommissioned by Groq; canopylabs/orpheus-v1-english is the current
# replacement. It requires the org to accept the model's terms in the
# Groq console before the API will serve it.
_MODEL = "canopylabs/orpheus-v1-english"
_VOICE = "troy"


def get_client() -> Groq:
    global _client
    if _client is None:
        _client = Groq(api_key=settings.groq_api_key)
    return _client


async def synthesize(text: str) -> bytes:
    # Same story as app/stt.py's transcribe(): the Groq SDK's speech call
    # is synchronous, so it's run off the event loop.
    def _call() -> bytes:
        response = get_client().audio.speech.create(
            model=_MODEL,
            voice=_VOICE,
            input=text,
            response_format="wav",
        )
        return response.read()

    audio_bytes = await asyncio.to_thread(_call)
    log_tts_usage(_MODEL, len(text), len(audio_bytes))
    return audio_bytes
