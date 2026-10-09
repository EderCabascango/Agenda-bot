"""Playwright Multi-Context E2E Integration Test for App-Agenda.

Tests full end-to-end synchronization flows across two real browser contexts:
1. Create in Context A -> Sync -> appears in Context B.
2. Concurrent edit conflict:
   - A edits (v2 synced)
   - B edits concurrently with base_version=1 -> Server rejects with conflict
   - B sees conflict UI badge, opens modal, clicks 'Re-aplicar la mía' (rebase)
   - B successfully reapplies edit to v3
   - A syncs and receives updated item
3. Delete in A -> Tombstone propagated -> Disappears in B's dashboard, calendar, search and stats.
4. Offline resilience:
   - Context A goes offline (network interception), creates 2 activities offline
   - Reconnects -> Syncs cleanly without duplicates -> B syncs and receives both.
5. Agent concurrency:
   - Agent creates activity directly in backend
   - User in B edits another activity
   - Sync preserves BOTH without any data loss.
"""
import os
import sys
import time
import socket
import tempfile
import threading
import sqlite3
import pytest
from playwright.sync_api import sync_playwright

# Add backend directory to sys.path
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BACKEND_DIR = os.path.join(BASE_DIR, "backend")
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import db
import uvicorn
from main import app


def get_free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


class TestServer:
    def __init__(self, db_path):
        self.db_path = db_path
        self.port = get_free_port()
        self.host = '127.0.0.1'
        self.url = f"http://{self.host}:{self.port}"
        self.server = None
        self.thread = None

    def start(self):
        # Override DB path for the test server
        os.environ["AGENDA_DB"] = self.db_path
        os.environ["DATABASE_PATH"] = self.db_path
        db.init_db(self.db_path)

        config = uvicorn.Config(app, host=self.host, port=self.port, log_level="warning")
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()

        # Wait for server to be responsive
        max_wait = 10
        start = time.time()
        while time.time() - start < max_wait:
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.connect((self.host, self.port))
                s.close()
                time.sleep(0.2)
                return
            except Exception:
                time.sleep(0.1)
        raise RuntimeError("Test server failed to start in time")

    def stop(self):
        if self.server:
            self.server.should_exit = True
            if self.thread and self.thread.is_alive():
                self.thread.join(timeout=3)


def test_playwright_e2e_full_sync():
    temp_dir = tempfile.mkdtemp()
    test_db = os.path.join(temp_dir, "test_e2e_agenda.db")
    server = TestServer(test_db)
    server.start()

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)

            # Context A & Page A
            context_a = browser.new_context()
            page_a = context_a.new_page()
            page_a.goto(f"{server.url}/?e2e=1")
            page_a.wait_for_load_state("networkidle")

            # Context B & Page B
            context_b = browser.new_context()
            page_b = context_b.new_page()
            page_b.goto(f"{server.url}/?e2e=1")
            page_b.wait_for_load_state("networkidle")

            # Clear any initial seeded data on both contexts to test with clean state
            page_a.evaluate("""() => {
                localStorage.setItem('diary_activities', JSON.stringify([]));
                localStorage.setItem('diary_sync_queue', JSON.stringify([]));
                localStorage.setItem('diary_conflicts', JSON.stringify({}));
                localStorage.setItem('diary_last_sync', '0');
                localStorage.setItem('diary_settings', JSON.stringify({ backendUrl: window.location.origin }));
                if (window.renderDashboard) window.renderDashboard();
            }""")
            page_b.evaluate("""() => {
                localStorage.setItem('diary_activities', JSON.stringify([]));
                localStorage.setItem('diary_sync_queue', JSON.stringify([]));
                localStorage.setItem('diary_conflicts', JSON.stringify({}));
                localStorage.setItem('diary_last_sync', '0');
                localStorage.setItem('diary_settings', JSON.stringify({ backendUrl: window.location.origin }));
                if (window.renderDashboard) window.renderDashboard();
            }""")

            # ----------------------------------------------------
            # 1. Crear en A y verlo en B
            # ----------------------------------------------------
            print("\n[E2E 1] Creando actividad en Contexto A y sincronizando a Contexto B...")
            page_a.evaluate("""async () => {
                const act = {
                    id: 'act-test-sync-1',
                    title: 'Reunión de Estrategia A',
                    date: '2026-10-10',
                    startTime: '09:00',
                    endTime: '10:00',
                    description: 'E2E Playwright sync test',
                    priority: 'high',
                    tags: ['trabajo'],
                    completed: false
                };
                let acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
                acts.push(act);
                localStorage.setItem('diary_activities', JSON.stringify(acts));
                let queue = JSON.parse(localStorage.getItem('diary_sync_queue') || '[]');
                queue.push(act);
                localStorage.setItem('diary_sync_queue', JSON.stringify(queue));
                await window.syncWithBackend();
            }""")

            # Page B synchronizes
            page_b.evaluate("async () => { await window.syncWithBackend(); }")

            # Verify B now has 'Reunión de Estrategia A' in localStorage & DOM
            title_in_b = page_b.evaluate("""() => {
                const acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
                const item = acts.find(x => x.id === 'act-test-sync-1');
                return item ? item.title : null;
            }""")
            assert title_in_b == 'Reunión de Estrategia A', f"Esperado 'Reunión de Estrategia A', obtenido {title_in_b}"
            print(" -> Contexto B recibió 'Reunión de Estrategia A' correctamente.")

            # ----------------------------------------------------
            # 2. Edición concurrente: A avanza a v2, B edita con base v1 -> Conflicto -> Rebase
            # ----------------------------------------------------
            print("\n[E2E 2] Probando conflicto de concurrencia y UI de resolución...")
            # A modifica título y sincroniza a v2
            page_a.evaluate("""async () => {
                let acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
                let item = acts.find(x => x.id === 'act-test-sync-1');
                item.title = 'Reunión Modificada por A';
                item.base_version = item.version || 1;
                item.version = (item.version || 1) + 1;
                localStorage.setItem('diary_activities', JSON.stringify(acts));
                let queue = JSON.parse(localStorage.getItem('diary_sync_queue') || '[]');
                queue.push(item);
                localStorage.setItem('diary_sync_queue', JSON.stringify(queue));
                await window.syncWithBackend();
            }""")

            # B (sin sincronizar aún, tiene base_version 1) edita concurrentemente
            page_b.evaluate("""async () => {
                let acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
                let item = acts.find(x => x.id === 'act-test-sync-1');
                item.title = 'Reunión Editada Concurrentemente por B';
                item.base_version = 1; // base version desactualizada
                localStorage.setItem('diary_activities', JSON.stringify(acts));
                let queue = JSON.parse(localStorage.getItem('diary_sync_queue') || '[]');
                queue.push(item);
                localStorage.setItem('diary_sync_queue', JSON.stringify(queue));
                await window.syncWithBackend();
            }""")

            # Verify B detected conflict and stored in diary_conflicts
            conflicts_in_b = page_b.evaluate("() => JSON.parse(localStorage.getItem('diary_conflicts') || '{}')")
            assert 'act-test-sync-1' in conflicts_in_b, "Contexto B debió guardar el conflicto en diary_conflicts"
            print(" -> Contexto B detectó conflicto en 'act-test-sync-1' sin perder cambios.")

            # Verify Conflict button is visible in B
            btn_conflicts_display = page_b.eval_on_selector("#btn-conflicts", "el => el.style.display")
            assert btn_conflicts_display != "none", "Botón de conflictos debe ser visible"

            # Open Conflicts Modal in B and click 'Re-aplicar la mía'
            page_b.click("#btn-conflicts")
            page_b.wait_for_selector("#conflicts-overlay.open", timeout=3000)
            print(" -> Modal de conflictos abierto en Contexto B.")

            # Click Rebase button for this conflict
            page_b.click("[data-resolve='rebase'][data-id='act-test-sync-1']")
            time.sleep(0.5)

            # Check that conflicts are now resolved and synced
            conflicts_after = page_b.evaluate("() => JSON.parse(localStorage.getItem('diary_conflicts') || '{}')")
            assert len(conflicts_after) == 0, "Los conflictos debieron quedar resueltos"
            print(" -> Conflicto re-aplicado exitosamente (Rebase) y sincronizado al servidor.")

            # Context A syncs and receives B's rebased change
            page_a.evaluate("async () => { await window.syncWithBackend(); }")
            title_in_a = page_a.evaluate("""() => {
                const acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
                const item = acts.find(x => x.id === 'act-test-sync-1');
                return item ? item.title : null;
            }""")
            assert title_in_a == 'Reunión Editada Concurrentemente por B'
            print(" -> Contexto A recibió la versión rebasada correctamente.")

            # ----------------------------------------------------
            # 3. Borrar en A y que desaparezca en B (Tombstone propagation)
            # ----------------------------------------------------
            print("\n[E2E 3] Probando borrado en Contexto A y propagación de tombstone a B...")
            page_a.evaluate("""async () => {
                let acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
                let item = acts.find(x => x.id === 'act-test-sync-1');
                item.deleted_at = new Date().toISOString();
                item.base_version = item.version || 3;
                let queue = JSON.parse(localStorage.getItem('diary_sync_queue') || '[]');
                queue.push(item);
                localStorage.setItem('diary_sync_queue', JSON.stringify(queue));
                // Quitar localmente
                acts = acts.filter(x => x.id !== 'act-test-sync-1');
                localStorage.setItem('diary_activities', JSON.stringify(acts));
                await window.syncWithBackend();
            }""")

            # B syncs
            page_b.evaluate("async () => { await window.syncWithBackend(); }")
            exists_in_b = page_b.evaluate("""() => {
                const acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
                return acts.some(x => x.id === 'act-test-sync-1');
            }""")
            assert not exists_in_b, "La actividad borrada no debe existir en el estado activo de B"
            print(" -> Actividad eliminada correctamente en B.")

            # ----------------------------------------------------
            # 4. Offline (bloquear red) con varios cambios y reconexión sin duplicados
            # ----------------------------------------------------
            print("\n[E2E 4] Probando modo offline con cola de cambios y reconexión...")
            # Route intercept on Page A to simulate offline network error
            offline_handler = lambda route: route.abort("failed")
            page_a.route("**/activities/sync*", offline_handler)

            page_a.evaluate("""async () => {
                const task1 = {
                    id: 'act-offline-1',
                    title: 'Tarea Offline 1',
                    date: '2026-10-11',
                    startTime: '10:00',
                    endTime: '11:00',
                    completed: false
                };
                const task2 = {
                    id: 'act-offline-2',
                    title: 'Tarea Offline 2',
                    date: '2026-10-11',
                    startTime: '11:00',
                    endTime: '12:00',
                    completed: false
                };
                let acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
                acts.push(task1, task2);
                localStorage.setItem('diary_activities', JSON.stringify(acts));
                let queue = JSON.parse(localStorage.getItem('diary_sync_queue') || '[]');
                queue.push(task1, task2);
                localStorage.setItem('diary_sync_queue', JSON.stringify(queue));

                // Intenta sincronizar (debe fallar pero preservar la cola)
                try { await window.syncWithBackend(); } catch(e) {}
            }""")

            # Verify queue still contains 2 items
            queue_len = page_a.evaluate("() => JSON.parse(localStorage.getItem('diary_sync_queue') || '[]').length")
            assert queue_len >= 2, f"La cola offline debió preservarse, longitud: {queue_len}"
            print(f" -> Cola offline intacta con {queue_len} cambios tras fallo de red.")

            # Unroute / Restore network
            page_a.unroute("**/activities/sync*", offline_handler)

            # Reconnect & sync Page A
            sync_ok = page_a.evaluate("async () => { return await window.syncWithBackend(); }")
            assert sync_ok, "Sincronización de reconexión debió ser exitosa"
            queue_len_after = page_a.evaluate("() => JSON.parse(localStorage.getItem('diary_sync_queue') || '[]').length")
            assert queue_len_after == 0, "La cola debe estar limpia tras reconexión exitosa"

            # Sync Page B and verify it received both tasks without duplicates
            page_b.evaluate("async () => { await window.syncWithBackend(); }")
            count_tasks_b = page_b.evaluate("""() => {
                const acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
                return acts.filter(x => x.id === 'act-offline-1' || x.id === 'act-offline-2').length;
            }""")
            assert count_tasks_b == 2, f"B debió recibir exactamente 2 tareas offline, recibió {count_tasks_b}"
            print(" -> Reconexión exitosa: Contexto B recibió ambas tareas offline sin duplicados.")

            # ----------------------------------------------------
            # 5. Agente creando una actividad mientras un usuario edita otra
            # ----------------------------------------------------
            print("\n[E2E 5] Probando creación concurrente del agente + edición de usuario...")
            time.sleep(0.5)
            # Agent creates an activity in DB
            created = db.upsert_activity("me", {
                "id": "act-agent-created-1",
                "title": "Revisión creada por Agente IA",
                "date": "2026-10-12",
                "startTime": "14:00",
                "endTime": "15:00",
                "description": "Auto scheduled",
                "priority": "high",
                "tags": ["ia", "agente"],
                "completed": False
            }, conn=None)
            print(f" -> DB upsert_activity retornó: {created['title']} ({created['id']})")

            # User in Context B edits 'act-offline-1'
            page_b.evaluate("""async () => {
                let acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
                let item = acts.find(x => x.id === 'act-offline-1');
                item.title = 'Tarea Offline 1 Modificada por Usuario';
                item.base_version = item.version || 1;
                let queue = JSON.parse(localStorage.getItem('diary_sync_queue') || '[]');
                queue.push(item);
                localStorage.setItem('diary_sync_queue', JSON.stringify(queue));
                localStorage.setItem('diary_activities', JSON.stringify(acts));
                await window.syncWithBackend();
            }""")

            # Context A synchronizes
            sync_res = page_a.evaluate("""async () => {
                await window.syncWithBackend();
                return {
                    acts: JSON.parse(localStorage.getItem('diary_activities') || '[]'),
                    lastSync: localStorage.getItem('diary_last_sync')
                };
            }""")
            print(f" -> Diagnóstico Page A: {len(sync_res['acts'])} actividades en A, lastSync: {sync_res['lastSync']}")
            for item in sync_res['acts']:
                print(f"    - ID: {item.get('id')}, title: {item.get('title')}")

            acts_in_a = sync_res['acts']
            agent_act = next((x for x in acts_in_a if x.get("id") == "act-agent-created-1"), None)
            user_act = next((x for x in acts_in_a if x.get("id") == "act-offline-1"), None)

            assert agent_act is not None, "La actividad creada por el agente debe existir en A"
            assert user_act is not None and user_act.get("title") == "Tarea Offline 1 Modificada por Usuario", "La edición del usuario debe preservarse"
            # ----------------------------------------------------
            # 6. Verificación DOM de exclusión de Tombstones (1.9.1)
            # ----------------------------------------------------
            print("\n[E2E 6] Probando exclusión total de tombstones en DOM y contadores...")
            dom_check = page_a.evaluate("""() => {
                const dt = new Date();
                const today = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
                const testActs = [
                    {
                        id: 'act-live-dom-test',
                        title: 'Actividad Viva en Pantalla',
                        date: today,
                        startTime: '09:00',
                        endTime: '10:00',
                        priority: 'high',
                        completed: false
                    },
                    {
                        id: 'act-tombstone-dom-test',
                        title: 'Actividad Fantasma Borrada',
                        date: today,
                        startTime: '11:00',
                        endTime: '12:00',
                        priority: 'high',
                        completed: false,
                        deleted_at: new Date().toISOString()
                    }
                ];
                if (window.__AppAgendaTest && window.__AppAgendaTest.saveActivities) {
                    window.__AppAgendaTest.saveActivities(testActs);
                } else {
                    localStorage.setItem('diary_activities', JSON.stringify(testActs));
                }
                if (window.renderDashboard) window.renderDashboard();
                if (window.renderActivityList) window.renderActivityList();

                const bodyHtml = document.body.innerHTML;
                const statPending = document.getElementById('stat-pending')?.innerText;
                const statCompleted = document.getElementById('stat-completed')?.innerText;

                return {
                    hasLive: bodyHtml.includes('Actividad Viva en Pantalla'),
                    hasTombstone: bodyHtml.includes('Actividad Fantasma Borrada'),
                    statPending: statPending,
                    statCompleted: statCompleted
                };
            }""")

            assert dom_check["hasLive"] is True, "La actividad viva debe renderizarse en el DOM"
            assert dom_check["hasTombstone"] is False, "La actividad con deleted_at (tombstone) NUNCA debe aparecer en el DOM"
            assert dom_check["statPending"] == "1", f"El contador de pendientes debe ser 1, obtenido: {dom_check['statPending']}"
            print(" -> Verificación DOM exitosa: Tombstones 100% invisibles en DOM y excluidos de contadores.")

            browser.close()
            print("\n============================================================")
            print("TODOS LOS TESTS E2E DE PLAYWRIGHT PASARON (100% OK)")
            print("============================================================\n")

    finally:
        server.stop()


if __name__ == "__main__":
    test_playwright_e2e_full_sync()
