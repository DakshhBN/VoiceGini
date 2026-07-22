# Voicebot

Speech-to-speech voicebot: browser mic/speaker in, cascaded STT -> LangGraph/Groq LLM -> TTS pipeline out, real-time over WebSocket.

## Architecture

- **Backend**: FastAPI + Uvicorn, SQLAlchemy 2.0 (async, psycopg3), Alembic, PyJWT + bcrypt auth, Pydantic v2 / pydantic-settings.
- **Frontend**: React 19 + TypeScript + Vite, Tailwind v4 + shadcn/ui, React Router v7, Axios.
- **AI orchestration**: LangGraph (single text-in/text-out chat node), Groq (Llama 3.3 70B via langchain-groq).
- **Voice pipeline**: FastAPI WebSocket transport with a ticket-based auth handshake, Groq Whisper (STT) and Groq Orpheus (`canopylabs/orpheus-v1-english` — the org must accept this model's terms in the Groq console before the API will serve it) for TTS. Continuous listening via a lightweight energy-based VAD (RMS threshold + silence hangover, not a neural model), with barge-in: each turn runs as a cancellable server task, so speaking over the assistant cancels its in-flight reply.
- **DB**: PostgreSQL (Neon).

## Build phases

- **Phase 0**: repo scaffolding, auth, DB — no voice yet.
- **Phase 1**: text-only chat backed by LangGraph (reuses ChatGini's pattern).
- **Phase 2**: add STT + WebSocket ticket auth, no VAD/TTS.
- **Phase 3**: add TTS, full voice loop, no interruption yet.
- **Phase 4** (current): add VAD + barge-in/interruption handling.
- **Phase 5**: polish, deploy, harden (always-on hosting, reconnection UX, cost tracking).

## Repo layout

```
backend/   FastAPI app, Alembic migrations
frontend/  React + Vite app
```

## Local development

See `backend/.env.example` and `frontend/.env.example` for required environment variables.

Backend is started via `run.py`, not the bare `uvicorn` CLI — psycopg's async
driver isn't compatible with Windows' default ProactorEventLoop, and the
policy has to be set before Uvicorn creates its event loop.

```
# backend
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python run.py

# frontend
cd frontend
npm install
npm run dev
```
