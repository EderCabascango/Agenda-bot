"""Grafo LangGraph: agent <-> tools, con confirmación humana antes de acciones destructivas."""
import os
from datetime import datetime
from zoneinfo import ZoneInfo

from langchain_core.messages import SystemMessage, ToolMessage
from langchain_groq import ChatGroq
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode
from langgraph.types import interrupt

from tools import ALL_TOOLS, DESTRUCTIVE

MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
TZ = ZoneInfo(os.getenv("AGENDA_TZ", "America/Bogota"))

SYSTEM = """Eres el asistente de la app "Mi Diario". Gestionas las actividades del usuario con herramientas.
Reglas:
- Hoy es {now}. La agenda funciona por ciclos del día 15 al 14 del mes siguiente; usa get_cycle_range, nunca calcules ciclos a mano.
- Antes de modificar o borrar, consulta con list_activities para obtener IDs reales. Nunca inventes IDs.
- Responde en español, breve y claro. Resume qué cambiaste.
- Si no estás seguro de qué actividad se refiere, pregunta."""


def build_graph(api_key: str | None = None, checkpointer=None):
    llm = ChatGroq(model=MODEL, temperature=0.1, api_key=api_key or os.getenv("GROQ_API_KEY"))
    llm_tools = llm.bind_tools(ALL_TOOLS)
    tool_node = ToolNode(ALL_TOOLS)

    def agent(state: MessagesState):
        now = datetime.now(TZ).strftime("%A %Y-%m-%d %H:%M")
        msgs = [SystemMessage(SYSTEM.format(now=now))] + state["messages"]
        return {"messages": [llm_tools.invoke(msgs)]}

    def route(state: MessagesState):
        last = state["messages"][-1]
        calls = getattr(last, "tool_calls", None)
        if not calls:
            return END
        return "confirm" if any(c["name"] in DESTRUCTIVE for c in calls) else "tools"

    def confirm(state: MessagesState):
        """Pausa el grafo y espera la decisión del usuario. Si rechaza, cancela las tool calls."""
        last = state["messages"][-1]
        pending = [c for c in last.tool_calls if c["name"] in DESTRUCTIVE]
        approved = interrupt({"type": "confirm", "actions": [
            {"tool": c["name"], "args": c["args"]} for c in pending]})
        if approved:
            return {}
        return {"messages": [ToolMessage("El usuario rechazó la acción.", tool_call_id=c["id"])
                             for c in last.tool_calls]}

    def after_confirm(state: MessagesState):
        return "agent" if isinstance(state["messages"][-1], ToolMessage) else "tools"

    g = StateGraph(MessagesState)
    g.add_node("agent", agent)
    g.add_node("tools", tool_node)
    g.add_node("confirm", confirm)
    g.add_edge(START, "agent")
    g.add_conditional_edges("agent", route, {"tools": "tools", "confirm": "confirm", END: END})
    g.add_conditional_edges("confirm", after_confirm, {"agent": "agent", "tools": "tools"})
    g.add_edge("tools", "agent")
    return g.compile(checkpointer=checkpointer or MemorySaver())
