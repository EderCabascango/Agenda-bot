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

import db  # noqa: E402

app = FastAPI(title="Mi Diario - Agente")
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



@app.get("/activities")
def get_activities(user: str = Depends(auth)):
    return db.list_activities(user)


@app.put("/activities")
def sync_activities(acts: list[dict], user: str = Depends(auth)):
    return {"saved": db.replace_all(user, acts)}


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

