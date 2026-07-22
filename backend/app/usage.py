import logging

# Not a billing-accurate accounting system - just enough visibility to spot
# runaway usage in the logs (Render's free-tier log stream, or local dev)
# without a separate dashboard. STT/TTS log size proxies rather than exact
# costs since Groq's transcription API only returns token/duration usage
# under response_format="verbose_json", and switching off the plain-text
# response format wasn't worth the added parsing for what this buys.
logger = logging.getLogger("app.usage")


def log_llm_usage(model: str, usage: dict | None) -> None:
    if not usage:
        logger.info("llm model=%s usage=unavailable", model)
        return
    logger.info(
        "llm model=%s input_tokens=%s output_tokens=%s total_tokens=%s",
        model,
        usage.get("input_tokens"),
        usage.get("output_tokens"),
        usage.get("total_tokens"),
    )


def log_stt_usage(model: str, audio_bytes: int, transcript_chars: int) -> None:
    logger.info("stt model=%s audio_bytes=%s transcript_chars=%s", model, audio_bytes, transcript_chars)


def log_tts_usage(model: str, text_chars: int, audio_bytes: int) -> None:
    logger.info("tts model=%s text_chars=%s audio_bytes=%s", model, text_chars, audio_bytes)
