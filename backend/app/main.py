import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.config import get_settings
from app.graph import close_graph_pool
from app.routers import auth, threads, voice

# Uvicorn configures its own uvicorn/uvicorn.access/uvicorn.error loggers
# but leaves the root logger untouched - without this, the app's own
# loggers (including app.usage) sit at the default WARNING level and INFO
# calls are silently dropped rather than reaching stdout.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
# httpx (used under the hood by the Groq SDK) logs one INFO line per
# outbound request - noisy at the same level as the usage logs it would
# otherwise bury.
logging.getLogger("httpx").setLevel(logging.WARNING)

logger = logging.getLogger("app")

settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    yield
    await close_graph_pool()


app = FastAPI(title="Voicebot API", lifespan=lifespan)


class ExceptionLoggingMiddleware:
    """Catches exceptions that would otherwise escape to Starlette's
    outermost ServerErrorMiddleware, which sits outside CORSMiddleware -
    responses built there never get CORS headers, so the browser reports
    a bare network failure instead of a 500, masking the real error.
    Registered before CORSMiddleware (see add_middleware order below) so
    CORSMiddleware wraps this and can still inject headers on the way out.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        response_started = False

        async def send_wrapper(message: dict) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            logger.exception("Unhandled exception on %s %s", scope["method"], scope["path"])
            if not response_started:
                response = JSONResponse(status_code=500, content={"detail": "Internal server error"})
                await response(scope, receive, send)


# Starlette's add_middleware() prepends, so the most-recently-added
# middleware ends up outermost. Registering the exception catcher first
# keeps it inside CORSMiddleware.
app.add_middleware(ExceptionLoggingMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(threads.router)
app.include_router(voice.router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
