from langchain_core.messages import BaseMessage
from langchain_groq import ChatGroq
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import END, START, MessagesState, StateGraph
from psycopg_pool import AsyncConnectionPool

from app.config import get_settings

settings = get_settings()

# Built lazily, not at import time, so a missing/invalid GROQ_API_KEY
# doesn't crash the app at startup (mirrors ChatGini's LLM client lesson).
_llm: ChatGroq | None = None


def get_llm() -> ChatGroq:
    global _llm
    if _llm is None:
        _llm = ChatGroq(model="llama-3.3-70b-versatile", api_key=settings.groq_api_key)
    return _llm


async def chat_node(state: MessagesState) -> dict[str, list[BaseMessage]]:
    response = await get_llm().ainvoke(state["messages"])
    return {"messages": [response]}


def _build_graph() -> StateGraph:
    graph = StateGraph(MessagesState)
    graph.add_node("chat", chat_node)
    graph.add_edge(START, "chat")
    graph.add_edge("chat", END)
    return graph


# LangGraph owns its own psycopg connection pool, independent of the
# SQLAlchemy engine in app/database.py, per ChatGini's two-pool design.
_checkpointer_pool: AsyncConnectionPool | None = None
_compiled_graph = None


async def get_graph():
    global _checkpointer_pool, _compiled_graph
    if _compiled_graph is None:
        # Kept small deliberately - a single-user dev setup doesn't need
        # many concurrent connections, and opening with wait=True + a
        # bounded timeout means a Neon connection problem surfaces as a
        # clear error immediately instead of hanging silently (the pool's
        # default open() is non-blocking and just retries in a background
        # thread, which reads as an indefinite hang from the caller).
        _checkpointer_pool = AsyncConnectionPool(
            conninfo=settings.psycopg_conninfo,
            open=False,
            min_size=1,
            max_size=5,
            kwargs={"autocommit": True},
        )
        await _checkpointer_pool.open(wait=True, timeout=15)
        checkpointer = AsyncPostgresSaver(_checkpointer_pool)
        await checkpointer.setup()
        _compiled_graph = _build_graph().compile(checkpointer=checkpointer)
    return _compiled_graph
