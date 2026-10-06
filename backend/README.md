# Backend – Agente LangGraph

API FastAPI con un agente LangGraph (Groq) que gestiona actividades mediante herramientas.

## Ejecutar en local
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
copy .env.example .env     # completa GROQ_API_KEY
.\.venv\Scripts\uvicorn main:app --reload --port 8000
```
En la app: **Ajustes → Agente LangGraph** → URL `http://localhost:8000` → Guardar.

## Tests (no requieren API key)
```powershell
.\.venv\Scripts\python -m pytest -q
```

## Endpoints
| Método | Ruta | Uso |
|---|---|---|
| GET | `/health` | Estado |
| GET / PUT | `/activities` | Leer / sincronizar actividades (last-write-wins) |
| POST | `/agent/chat` | `{message, thread_id}` → `{reply, pending}` |
| POST | `/agent/confirm` | `{thread_id, approved}` reanuda tras confirmación |

Las acciones destructivas (`delete_activity`) pausan el grafo con `interrupt()` hasta que el usuario confirma.

## Despliegue (Render / Railway)
- Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
- Variables: `GROQ_API_KEY`, `APP_TOKEN`, `CORS_ORIGINS` (tu dominio de Vercel).
- Importante: SQLite y `MemorySaver` son efímeros en planes gratuitos. Para persistir, cambia `db.py` a Postgres/Supabase y usa `PostgresSaver` en `agent.py`.
- La web en Vercel (https) solo puede llamar a un backend https.
