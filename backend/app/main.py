import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.config import get_settings
from app.routers import auth

logger = logging.getLogger("app")

settings = get_settings()

app = FastAPI(title="Voicebot API")


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


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
