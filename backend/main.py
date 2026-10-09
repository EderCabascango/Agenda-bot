"""API del backend: sincronización de actividades + agente LangGraph."""
import os

from dotenv import load_dotenv

load_dotenv()

from fastapi import Depends, FastAPI, Header, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from langchain_core.messages import AIMessage, HumanMessage  # noqa: E402
from langgraph.types import Command  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from contextlib import asynccontextmanager
import db

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Purga de tombstones > 30 días al inicio
    try:
        purged = db.purge_tombstones(days=30)
        if purged:
            print(f"[INFO] Tombstones purgados en startup: {purged}")
    except Exception as e:
        print(f"[WARN] Error al purgar tombstones en startup: {e}")
    yield

app = FastAPI(title="Mi Diario - Agente", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"], allow_headers=["*"],
)

_graph = None



def is_agent_configured() -> bool:
    provider = os.getenv("LLM_PROVIDER", "groq").lower()
    if provider == "groq":
        return bool(os.getenv("GROQ_API_KEY"))
    elif provider == "openrouter":
        return bool(os.getenv("OPENROUTER_API_KEY"))
    elif provider == "gemini":
        return bool(os.getenv("GEMINI_API_KEY"))
    elif provider == "ollama":
        return True
    return bool(os.getenv("GROQ_API_KEY"))


def graph():
    """Se construye bajo demanda para que /health y la sincronización funcionen sin API key."""
    global _graph
    if _graph is None:
        if not is_agent_configured():
            prov = os.getenv("LLM_PROVIDER", "groq")
            raise HTTPException(503, f"Falta API Key configurada para el proveedor '{prov}' en el backend.")
        from agent import build_graph
        _graph = build_graph()
    return _graph


def auth(x_app_token: str | None = Header(default=None), x_user_id: str = Header(default="me")) -> str:
    expected = os.getenv("APP_TOKEN")
    if expected and x_app_token != expected:
        raise HTTPException(401, "Token inválido.")
    return x_user_id


class Chat(BaseModel):
    message: str
    thread_id: str = "default"


class Confirm(BaseModel):
    thread_id: str = "default"
    approved: bool


def _result(res: dict) -> dict:
    if res.get("__interrupt__"):
        return {"reply": "", "pending": res["__interrupt__"][0].value}
    last = next((m for m in reversed(res["messages"]) if isinstance(m, AIMessage) and m.content), None)
    return {"reply": last.content if last else "", "pending": None}


@app.get("/health")
def health():
    return {
        "ok": True,
        "agent_ready": is_agent_configured(),
        "provider": os.getenv("LLM_PROVIDER", "groq"),
    }



class SyncRequest(BaseModel):
    changes: list[dict] = []
    since: str | None = None


@app.get("/activities")
def get_activities(
    since: str | None = None,
    start: str | None = None,
    end: str | None = None,
    include_deleted: bool = False,
    user: str = Depends(auth)
):
    return db.list_activities(user, start=start, end=end, since=since, include_deleted=include_deleted)


@app.post("/activities/sync")
def sync_activities_endpoint(body: SyncRequest, user: str = Depends(auth)):
    try:
        return db.sync_changes(user, body.changes, since=body.since)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.put("/activities")
def legacy_put_activities(acts: list[dict], user: str = Depends(auth)):
    """Compatibilidad retroactiva: realiza upsert no destructivo dentro de una transacción."""
    try:
        res = db.sync_changes(user, acts)
        return {"saved": res["applied"], "conflicts": res["conflicts"]}
    except ValueError as e:
        raise HTTPException(400, str(e))



@app.post("/agent/chat")
def chat(body: Chat, user: str = Depends(auth)):
    cfg = {"configurable": {"thread_id": f"{user}:{body.thread_id}", "user_id": user}}
    try:
        res = graph().invoke({"messages": [HumanMessage(body.message)]}, cfg)
    except HTTPException:
        raise
    except Exception as e:  # error real del proveedor al cliente
        raise HTTPException(502, f"Error del modelo: {e}")
    return _result(res)


@app.post("/agent/confirm")
def confirm(body: Confirm, user: str = Depends(auth)):
    cfg = {"configurable": {"thread_id": f"{user}:{body.thread_id}", "user_id": user}}
    try:
        res = graph().invoke(Command(resume=body.approved), cfg)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Error del modelo: {e}")
    return _result(res)


# Monta el frontend web para servir todo en una sola URL
WEB_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "web"))
if os.path.isdir(WEB_DIR):
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")

