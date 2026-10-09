# Mi Diario (App-Agenda) 🗓️🤖

Aplicación web y móvil de productividad personal con asistente LangGraph inteligente, almacenamiento SQLite en servidor, soporte offline resiliente y sincronización incremental bidireccional basada en versiones y tombstones.

## 🚀 Arquitectura de Sincronización (Fase 1 / 1.5 / 1.6 / 1.7)

1. **Autoridad del Servidor & Versiones Monotónicas:**
   - Toda mutación asigna `updated_at` y `version` (monotónica) en el backend.
   - Las ediciones de registros existentes requieren `base_version`.
   - Si `base_version < server_version` o `base_version` es omitida en registros existentes, el servidor rechaza la sobrescritura silenciosa y devuelve un conflicto.

2. **Resolución de Conflictos en UI (`diary_conflicts`):**
   - Los conflictos se guardan localmente sin descartar la edición del usuario.
   - Un badge en la barra superior (`#btn-conflicts`) y un modal dedicado permiten:
     - **Usar la del servidor**: descarta el cambio local y adopta la versión remota.
     - **Re-aplicar la mía (Rebase)**: asigna la nueva `base_version` remota y re-encola el cambio para subida inmediata.

3. **Propagación de Tombstones y Purga Periódica:**
   - Los borrados son lógicos (`deleted_at` no nulo).
   - Se excluyen automáticamente en todas las vistas (Dashboard, Calendario, Buscador, Filtros y Alarmas).
   - Los tombstones mayores a 30 días se purgan en startup y mediante una tarea periódica en lifespan cada 24h. Si un cliente solicita sincronización anterior al límite de retención, el servidor emite `resync_required=True` (full pull con merge de cambios pendientes).

4. **Resiliencia Offline:**
   - Cola de cambios (`diary_sync_queue`) idempotente y persistente ante fallos de red.
   - Deduplicación y preservación estricta de la cola local hasta confirmación exitosa del backend.

5. **Copias de Respaldo Automáticas:**
   - Respaldo permanente e inmutable `pre_migration_*.db` antes de cualquier migración de esquema.
   - Rotación automática de respaldos (`auto_*_backup_*.db`) conservando los últimos 5.

---

## 🧪 Ejecución de Tests

Comando único para ejecutar todas las suites de prueba (Unitarias JS, Backend Pytest, Integración y Playwright E2E Multi-Contexto):

```bash
npm test
```

O individualmente:

```bash
# 1. Tests Unitarios Frontend (15 tests SyncCore)
npm run test:sync

# 2. Tests Unitarios y de Integración Backend (14 tests Pytest)
npm run test:backend

# 3. Test de Integración SyncCore <-> FastAPI/SQLite
npm run test:integration

# 4. Test E2E Playwright Multi-Contexto (5 flujos reales en navegador)
npm run test:e2e
```
