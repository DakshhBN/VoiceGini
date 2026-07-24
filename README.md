# VoiceGini

Speech-to-speech voicebot: browser mic/speaker in, cascaded STT -> LangGraph/Groq LLM -> TTS pipeline out, real-time over WebSocket.

**Live**: https://voicegini-frontend.onrender.com
(free-tier backend cold-starts after 15 min idle - first request/connect can take 30-60s)

## Features

- Real-time voice conversation with barge-in (talk over the assistant to interrupt it)
- Text chat as an alternative to voice, same threads/history either way
- Chat threads: create, rename, delete; auto-titled from the first message
- Resizable sidebar
- Coral/warm-white UI theme

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
- **Phase 4**: add VAD + barge-in/interruption handling.
- **Phase 5**: polish, deploy, harden.
- **Post-launch** (current): rebrand, UI redesign, thread management, auto-titling.

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

## Deployment

`render.yaml` at the repo root is a [Render Blueprint](https://render.com/docs/blueprints)
defining two free-tier services: `voicegini-backend` (Python web service) and
`voicegini-frontend` (static site, Vite build output, SPA rewrite routing).

Both reuse the same Neon Postgres database as local dev - no separate prod DB
or migration step needed. Deploy via Render's dashboard ("New +" -> "Blueprint",
point it at this repo), then in each service's Environment tab fill in the
`sync: false` variables the blueprint left blank (secrets aren't committed):

- `voicegini-backend`: `DATABASE_URL`, `JWT_SECRET` (use a real random value,
  not the local dev placeholder), `GROQ_API_KEY`, `CORS_ORIGINS_RAW` (the
  frontend's Render URL, e.g. `https://voicegini-frontend.onrender.com`)
- `voicegini-frontend`: `VITE_API_URL` (the backend's Render URL, e.g.
  `https://voicegini-backend.onrender.com`) - this is baked in at build time,
  so set it before the first build, or edit it and trigger a manual redeploy

**Free-tier caveat**: the backend web service spins down after 15 minutes of
inactivity and cold-starts (~30-60s) on the next request or WebSocket connect.
The static frontend has no such delay. There's no way around this without a
paid always-on plan.
