import asyncio
import sys

# Must run before Uvicorn creates its event loop: psycopg's async driver
# can't run on Windows' default ProactorEventLoop, and by the time
# app.main is imported (inside Uvicorn's already-running loop) it's too
# late to switch policies.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import uvicorn

if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
