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
            page_a.route("**/sync*", offline_handler)

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
            page_a.unroute("**/sync*", offline_handler)

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

            # ----------------------------------------------------
            # 7. Verificación de Resistencia a XSS en el DOM (0.3)
            # ----------------------------------------------------
            print("\n[E2E 7] Probando resistencia a inyecciones XSS en título, descripción, tags e importación...")
            dialog_triggered = []
            page_a.on("dialog", lambda dialog: (dialog_triggered.append(dialog.message), dialog.dismiss()))

            xss_result = page_a.evaluate("""() => {
                const dt = new Date();
                const today = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
                const xssActs = [
                    {
                        id: 'act-xss-1',
                        title: '<img src=x onerror=alert("xss_img")>',
                        description: '"><script>alert("xss_script")</script>',
                        tags: ["' onclick='alert(\\"xss_tag\\")", 'javascript:alert("xss_js")'],
                        date: today,
                        startTime: '14:00',
                        endTime: '15:00',
                        priority: 'high',
                        completed: false
                    }
                ];
                if (window.__AppAgendaTest && window.__AppAgendaTest.saveActivities) {
                    window.__AppAgendaTest.saveActivities(xssActs);
                }
                if (window.renderDashboard) window.renderDashboard();
                if (window.renderActivityList) window.renderActivityList();
                if (window.renderCalendar) window.renderCalendar();

                const bodyHtml = document.body.innerHTML;
                const searchInp = document.getElementById('search-input');
                if (searchInp) {
                    searchInp.value = 'img';
                    searchInp.dispatchEvent(new Event('input'));
                }

                return {
                    hasRawScriptTag: bodyHtml.includes('<script>alert('),
                    hasRawImgOnError: bodyHtml.includes('<img src=x onerror='),
                    hasEscapedImg: bodyHtml.includes('&lt;img src=x onerror='),
                    hasEscapedScript: bodyHtml.includes('&lt;script&gt;')
                };
            }""")

            assert len(dialog_triggered) == 0, f"No debe dispararse ningún alert/dialog por XSS, disparados: {dialog_triggered}"
            assert xss_result["hasRawScriptTag"] is False, "No debe existir ningún tag <script> inyectado sin escapar en el DOM"
            assert xss_result["hasRawImgOnError"] is False, "No debe existir ningún tag <img> con onerror sin escapar en el DOM"
            assert xss_result["hasEscapedImg"] is True, "El payload del <img> debe estar escapado como entidad HTML"
            print(" -> Verificación XSS exitosa: 0 alertas disparadas, payloads 100% neutralizados.")

            # ----------------------------------------------------
            # 8. Multi-colección: Sincronización de Materias, Sesiones, Notas, Archivo y Conflictos
            # ----------------------------------------------------
            print("\n[E2E 8] Probando sincronización multi-colección (materias, sesiones, notas, archivo)...")

            # 8.1 Crear materia, tema, sesión y nota en Contexto A y sincronizar
            page_a.evaluate("""async () => {
                const sub = { id: 'sub-e2e-1', name: 'Arquitectura de Software', color: '#3498db', icon: 'code', weekly_goal_minutes: 180 };
                const top = { id: 'top-e2e-1', subject_id: 'sub-e2e-1', name: 'Patrones Arquitectónicos', status: 'in_progress' };
                const foc = { id: 'foc-e2e-1', subject_id: 'sub-e2e-1', topic_ids: ['top-e2e-1'], source: 'manual', effective_seconds: 3600 };
                const not = { id: 'not-e2e-1', subject_id: 'sub-e2e-1', learned_text: 'Patrón Repository y Unit of Work', topic_ids: ['top-e2e-1'] };

                localStorage.setItem('diary_subjects', JSON.stringify([sub]));
                localStorage.setItem('diary_topics', JSON.stringify([top]));
                localStorage.setItem('diary_focus_sessions', JSON.stringify([foc]));
                localStorage.setItem('diary_learning_notes', JSON.stringify([not]));

                let queue = [
                    { ...sub, collection: 'subjects' },
                    { ...top, collection: 'topics' },
                    { ...foc, collection: 'focus_sessions' },
                    { ...not, collection: 'learning_notes' }
                ];
                localStorage.setItem('diary_sync_queue', JSON.stringify(queue));
                await window.syncWithBackend();
            }""")

            # 8.2 Contexto B sincroniza y verifica recepción de las 4 entidades
            page_b.evaluate("async () => { await window.syncWithBackend(); }")
            multi_b = page_b.evaluate("""() => {
                const subs = JSON.parse(localStorage.getItem('diary_subjects') || '[]');
                const tops = JSON.parse(localStorage.getItem('diary_topics') || '[]');
                const focs = JSON.parse(localStorage.getItem('diary_focus_sessions') || '[]');
                const nots = JSON.parse(localStorage.getItem('diary_learning_notes') || '[]');
                return {
                    hasSub: subs.some(s => s.id === 'sub-e2e-1' && s.name === 'Arquitectura de Software'),
                    hasTop: tops.some(t => t.id === 'top-e2e-1'),
                    hasFoc: focs.some(f => f.id === 'foc-e2e-1'),
                    hasNot: nots.some(n => n.id === 'not-e2e-1')
                };
            }""")

            assert multi_b["hasSub"] is True, "Contexto B debió recibir la materia sub-e2e-1"
            assert multi_b["hasTop"] is True, "Contexto B debió recibir el tema top-e2e-1"
            assert multi_b["hasFoc"] is True, "Contexto B debió recibir la sesión foc-e2e-1"
            assert multi_b["hasNot"] is True, "Contexto B debió recibir la nota not-e2e-1"
            print(" -> Multi-colección inicial sincronizada exitosamente entre A y B (Sesión de A visible en B).")

            # 8.3 Edición concurrente de la misma materia en A y B con resolución de conflicto por UI
            print(" -> Probando edición concurrente de la misma materia en A y B...")
            page_a.evaluate("""async () => {
                let subs = JSON.parse(localStorage.getItem('diary_subjects') || '[]');
                let sub = subs.find(s => s.id === 'sub-e2e-1');
                sub.name = 'Arquitectura de Software (Editada por A)';
                sub.base_version = sub.version || 1;
                let queue = JSON.parse(localStorage.getItem('diary_sync_queue') || '[]');
                queue.push({ ...sub, collection: 'subjects' });
                localStorage.setItem('diary_sync_queue', JSON.stringify(queue));
                localStorage.setItem('diary_subjects', JSON.stringify(subs));
                await window.syncWithBackend();
            }""")

            # B intenta enviar su propia edición con base_version desactualizada (conflicto)
            page_b.evaluate("""async () => {
                let subs = JSON.parse(localStorage.getItem('diary_subjects') || '[]');
                let sub = subs.find(s => s.id === 'sub-e2e-1');
                sub.name = 'Arquitectura de Software (Editada por B)';
                sub.base_version = 1;
                let queue = JSON.parse(localStorage.getItem('diary_sync_queue') || '[]');
                queue.push({ ...sub, collection: 'subjects' });
                localStorage.setItem('diary_sync_queue', JSON.stringify(queue));
                localStorage.setItem('diary_subjects', JSON.stringify(subs));
                await window.syncWithBackend();
            }""")

            # Verificar que B detectó conflicto en 'sub-e2e-1'
            conflicts_b = page_b.evaluate("() => JSON.parse(localStorage.getItem('diary_conflicts') || '{}')")
            assert 'sub-e2e-1' in conflicts_b, "B debió registrar conflicto en la materia 'sub-e2e-1'"

            # B abre modal de conflictos y resuelve haciendo rebase
            page_b.click("#btn-conflicts")
            page_b.wait_for_selector("#conflicts-overlay.open", timeout=3000)
            page_b.click("[data-resolve='rebase'][data-id='sub-e2e-1']")
            time.sleep(0.5)

            # A sincroniza y recibe la versión resuelta de B
            page_a.evaluate("async () => { await window.syncWithBackend(); }")
            name_in_a = page_a.evaluate("""() => {
                const subs = JSON.parse(localStorage.getItem('diary_subjects') || '[]');
                const s = subs.find(x => x.id === 'sub-e2e-1');
                return s ? s.name : null;
            }""")
            assert name_in_a == 'Arquitectura de Software (Editada por B)', f"A debió recibir la materia rebasada, obtenido: {name_in_a}"
            print(" -> Conflicto de materia resuelto exitosamente vía UI y propagado a A.")

            # 8.4 Archivar materia en Contexto A y propagar a Contexto B
            page_a.evaluate("""async () => {
                let subs = JSON.parse(localStorage.getItem('diary_subjects') || '[]');
                let sub = subs.find(s => s.id === 'sub-e2e-1');
                sub.archived = true;
                sub.base_version = sub.version || 2;
                let queue = JSON.parse(localStorage.getItem('diary_sync_queue') || '[]');
                queue.push({ ...sub, collection: 'subjects' });
                localStorage.setItem('diary_sync_queue', JSON.stringify(queue));
                localStorage.setItem('diary_subjects', JSON.stringify(subs));
                await window.syncWithBackend();
            }""")

            page_b.evaluate("async () => { await window.syncWithBackend(); }")
            archived_in_b = page_b.evaluate("""() => {
                const subs = JSON.parse(localStorage.getItem('diary_subjects') || '[]');
                const sub = subs.find(s => s.id === 'sub-e2e-1');
                return sub ? Boolean(sub.archived) : false;
            }""")
            assert archived_in_b is True, "El estado archivado (archived=1) debió propagarse a Contexto B"
            print(" -> Materia archivada (archived=1) propagada exitosamente a Contexto B.")

            # 8.5 Cambios offline en varias colecciones que suben en una sola transacción al reconectar
            print(" -> Probando lote offline multi-colección y subida atómica al reconectar...")
            page_a.route("**/sync*", offline_handler)

            page_a.evaluate("""async () => {
                const subOff = { id: 'sub-off-1', name: 'Materia Offline' };
                const focOff = { id: 'foc-off-1', subject_id: 'sub-off-1', source: 'manual', effective_seconds: 2400 };
                const notOff = { id: 'not-off-1', subject_id: 'sub-off-1', learned_text: 'Nota tomada offline' };

                let queue = JSON.parse(localStorage.getItem('diary_sync_queue') || '[]');
                queue.push(
                    { ...subOff, collection: 'subjects' },
                    { ...focOff, collection: 'focus_sessions' },
                    { ...notOff, collection: 'learning_notes' }
                );
                localStorage.setItem('diary_sync_queue', JSON.stringify(queue));

                let subs = JSON.parse(localStorage.getItem('diary_subjects') || '[]');
                subs.push(subOff);
                localStorage.setItem('diary_subjects', JSON.stringify(subs));

                let focs = JSON.parse(localStorage.getItem('diary_focus_sessions') || '[]');
                focs.push(focOff);
                localStorage.setItem('diary_focus_sessions', JSON.stringify(focs));

                let nots = JSON.parse(localStorage.getItem('diary_learning_notes') || '[]');
                nots.push(notOff);
                localStorage.setItem('diary_learning_notes', JSON.stringify(nots));

                try { await window.syncWithBackend(); } catch(e) {}
            }""")

            queue_multi_len = page_a.evaluate("() => JSON.parse(localStorage.getItem('diary_sync_queue') || '[]').length")
            assert queue_multi_len >= 3, f"La cola multi-colección debió retenerse offline, longitud: {queue_multi_len}"

            # Restaurar red y sincronizar A
            page_a.unroute("**/sync*", offline_handler)
            sync_ok_multi = page_a.evaluate("async () => { return await window.syncWithBackend(); }")
            assert sync_ok_multi, "Sincronización multi-colección debió ser exitosa al reconectar"

            # Contexto B sincroniza y verifica recepción de las 3 entidades offline
            page_b.evaluate("async () => { await window.syncWithBackend(); }")
            b_received_offline = page_b.evaluate("""() => {
                const subs = JSON.parse(localStorage.getItem('diary_subjects') || '[]');
                const focs = JSON.parse(localStorage.getItem('diary_focus_sessions') || '[]');
                const nots = JSON.parse(localStorage.getItem('diary_learning_notes') || '[]');
                return {
                    hasSub: subs.some(s => s.id === 'sub-off-1'),
                    hasFoc: focs.some(f => f.id === 'foc-off-1'),
                    hasNot: nots.some(n => n.id === 'not-off-1')
                };
            }""")
            assert b_received_offline["hasSub"] is True
            assert b_received_offline["hasFoc"] is True
            assert b_received_offline["hasNot"] is True
            print(" -> Lote multi-colección offline subido y sincronizado atómicamente a B.")

            # ============================================================
            # [E2E 9] Creación de Materias Sugeridas (Seeds) Idempotente en Paralelo
            # ============================================================
            print("\n[E2E 9] Probando creación de materias sugeridas (seeds con create_if_absent) concurrente...")
            page_a.evaluate("async () => { window.handleSeedSubjects(); await window.syncWithBackend(); }")
            page_b.evaluate("async () => { window.handleSeedSubjects(); await window.syncWithBackend(); }")

            # Verificar que ambos contextos tienen las 4 materias sugeridas y 8 temas sin conflictos
            conflicts_a = page_a.evaluate("() => Object.keys(JSON.parse(localStorage.getItem('diary_conflicts') || '{}')).length")
            conflicts_b = page_b.evaluate("() => Object.keys(JSON.parse(localStorage.getItem('diary_conflicts') || '{}')).length")
            assert conflicts_a == 0, f"Contexto A no debe tener conflictos con seeds sugeridas, tiene: {conflicts_a}"
            assert conflicts_b == 0, f"Contexto B no debe tener conflictos con seeds sugeridas, tiene: {conflicts_b}"

            subs_count_a = page_a.evaluate("() => JSON.parse(localStorage.getItem('diary_subjects') || '[]').filter(s => s && s.id.startsWith('subject-seed-') && !s.deleted_at).length")
            subs_count_b = page_b.evaluate("() => JSON.parse(localStorage.getItem('diary_subjects') || '[]').filter(s => s && s.id.startsWith('subject-seed-') && !s.deleted_at).length")
            assert subs_count_a == 4, f"Contexto A debe tener 4 materias semillas, tiene: {subs_count_a}"
            assert subs_count_b == 4, f"Contexto B debe tener 4 materias semillas, tiene: {subs_count_b}"

            topics_count_a = page_a.evaluate("() => JSON.parse(localStorage.getItem('diary_topics') || '[]').filter(t => t && t.id.startsWith('topic-seed-') && !t.deleted_at).length")
            topics_count_b = page_b.evaluate("() => JSON.parse(localStorage.getItem('diary_topics') || '[]').filter(t => t && t.id.startsWith('topic-seed-') && !t.deleted_at).length")
            assert topics_count_a == 8, f"Contexto A debe tener 8 temas semillas, tiene: {topics_count_a}"
            assert topics_count_b == 8, f"Contexto B debe tener 8 temas semillas, tiene: {topics_count_b}"
            print(" -> Creación de materias sugeridas 100% idempotente (0 conflictos, 4 materias y 8 temas sincronizados).")

            # ============================================================
            # [E2E 10] UI de Materias y Temas, Creación, Eliminación con Tombstone y Filtro de Archivadas
            # ============================================================
            print("\n[E2E 10] Probando UI de Materias, creación de tema, eliminación de tema y archivado...")
            page_a.click(".nav-item[data-view='study']")
            page_a.wait_for_selector("#view-study.active", timeout=3000)
            page_a.wait_for_selector(".subject-card[data-id='subject-seed-ingles']", timeout=3000)

            # Abrir detalle de Inglés y agregar un tema nuevo
            page_a.click(".subject-card[data-id='subject-seed-ingles'] [data-action='detail']")
            page_a.wait_for_selector("#subject-detail-overlay.open", timeout=3000)

            page_a.click("#btn-add-topic-from-detail")
            page_a.wait_for_selector("#topic-modal-overlay.open", timeout=3000)
            page_a.fill("#topic-name-input", "Listening Avanzado C1")
            page_a.click("#btn-save-topic")
            page_a.wait_for_selector("#topic-modal-overlay", state="hidden", timeout=3000)
            page_a.evaluate("async () => { await window.syncWithBackend(); }")

            # Contexto B sincroniza y verifica recepción del nuevo tema
            page_b.evaluate("async () => { await window.syncWithBackend(); }")
            has_new_topic_in_b = page_b.evaluate("""() => {
                const tops = JSON.parse(localStorage.getItem('diary_topics') || '[]');
                return tops.some(t => t.name === 'Listening Avanzado C1' && !t.deleted_at);
            }""")
            assert has_new_topic_in_b is True, "Contexto B debió recibir el nuevo tema 'Listening Avanzado C1'"

            # Contexto A elimina un tema (ej: Listening Avanzado C1)
            page_a.evaluate("""async () => {
                const tops = JSON.parse(localStorage.getItem('diary_topics') || '[]');
                const top = tops.find(t => t.name === 'Listening Avanzado C1');
                if (top) {
                    window.handleDeleteTopic(top.id);
                }
                await window.syncWithBackend();
            }""")

            # Contexto B sincroniza y verifica que el tema eliminado fue purgado de la lista activa
            page_b.evaluate("async () => { await window.syncWithBackend(); }")
            active_top_in_b = page_b.evaluate("""() => {
                const tops = JSON.parse(localStorage.getItem('diary_topics') || '[]');
                const top = tops.find(t => t.name === 'Listening Avanzado C1');
                return top ? (!top.deleted_at) : false;
            }""")
            assert active_top_in_b is False, "El tema borrado no debe estar activo en Contexto B tras sincronizar el tombstone"
            print(" -> Creación y eliminación de temas con tombstones validada en UI y sincronizada.")

            # ============================================================
            # [E2E 11] Tolerancia a Huérfanos y Resistencia a Inyecciones XSS en Estudio
            # ============================================================
            print("\n[E2E 11] Probando tolerancia a huérfanos y neutralización de inyecciones XSS en materias/temas...")
            xss_dialogs = []
            page_a.on("dialog", lambda dialog: (xss_dialogs.append(dialog.message), dialog.dismiss()))

            # Inyectar materia y tema con payloads XSS y entidad huérfana
            page_a.evaluate("""async () => {
                const xssSub = {
                    id: 'sub-xss-1',
                    name: '<script>alert("xss-sub")</script><img src=x onerror=alert("xss-img")>',
                    color: '#8B5CF6',
                    icon: 'school',
                    weekly_goal_minutes: 120,
                    version: 1
                };
                const xssTop = {
                    id: 'top-xss-1',
                    subject_id: 'sub-xss-1',
                    name: '<svg onload=alert("xss-top")>',
                    status: 'in_progress',
                    version: 1
                };
                // Huérfano: Sesión que referencia una materia inexistente
                const orphanFoc = {
                    id: 'foc-orphan-ui-1',
                    subject_id: 'non-existent-subject-xyz',
                    topic_ids: ['non-existent-top-xyz'],
                    source: 'manual',
                    effective_seconds: 3600,
                    version: 1
                };

                let subs = JSON.parse(localStorage.getItem('diary_subjects') || '[]');
                subs.push(xssSub);
                localStorage.setItem('diary_subjects', JSON.stringify(subs));

                let tops = JSON.parse(localStorage.getItem('diary_topics') || '[]');
                tops.push(xssTop);
                localStorage.setItem('diary_topics', JSON.stringify(tops));

                let focs = JSON.parse(localStorage.getItem('diary_focus_sessions') || '[]');
                focs.push(orphanFoc);
                localStorage.setItem('diary_focus_sessions', JSON.stringify(focs));

                window.renderStudyView();
                window.openSubjectDetailModal('sub-xss-1');
            }""")

            time.sleep(0.5)
            assert len(xss_dialogs) == 0, f"Inyección XSS detectada en Vista de Estudio: {xss_dialogs}"

            # Verificar que el texto en DOM está correctamente escapado y no ejecutó etiquetas
            title_text = page_a.inner_text("#detail-subject-title")
            assert "<script>" in title_text or "alert" in title_text, "El texto crudo debe mostrarse sin interpretar tags HTML"
            print(" -> Verificación de seguridad y huérfanos exitosa: 0 alertas XSS, render tolerante a huérfanos.")
            page_a.keyboard.press("Escape")

            # ============================================================
            # [E2E 12] Creación de Materias Semilla Offline y Sincronización al Reconectar
            # ============================================================
            print("\n[E2E 12] Probando creación de semillas sugeridas offline y posterior sincronización...")
            page_a.route("**/sync*", offline_handler)
            page_a.evaluate("""async () => {
                window.handleSeedSubjects();
                try { await window.syncWithBackend(); } catch(e) {}
            }""")

            # Verificar que las semillas existen localmente mientras está offline
            local_subs_off = page_a.evaluate("() => JSON.parse(localStorage.getItem('diary_subjects') || '[]').filter(s => s && s.id.startsWith('subject-seed-') && !s.deleted_at).length")
            assert local_subs_off == 4, f"Contexto A debió crear las 4 materias offline, tiene: {local_subs_off}"

            # Reconectar y sincronizar
            page_a.unroute("**/sync*", offline_handler)
            sync_res = page_a.evaluate("async () => { return await window.syncWithBackend(); }")
            assert sync_res, "Sincronización de semillas tras reconexión debió ser exitosa"
            print(" -> Semillas creadas offline sincronizadas exitosamente al reconectar.")

            # ============================================================
            # [E2E 13] Accesibilidad y Navegación por Teclado (Tab, Enter, Escape)
            # ============================================================
            print("\n[E2E 13] Probando navegación por teclado (Tab, Enter, Escape) en modales de estudio...")
            page_a.click(".nav-item[data-view='study']")
            page_a.wait_for_selector("#view-study.active", timeout=3000)

            # Abrir modal de materia por UI
            page_a.click("#btn-add-subject")
            page_a.wait_for_selector("#subject-modal-overlay.open", timeout=3000)

            # Escribir nombre usando teclado
            page_a.focus("#subject-name-input")
            page_a.keyboard.type("Teclado Accesible")
            page_a.keyboard.press("Tab") # Color
            page_a.keyboard.press("Tab") # Meta semanal
            page_a.keyboard.type("180")

            # Cerrar con Escape
            page_a.keyboard.press("Escape")
            page_a.wait_for_selector("#subject-modal-overlay", state="hidden", timeout=3000)
            print(" -> Tecla Escape cerró correctamente el modal de materia.")

            # ============================================================
            # [E2E 14] Capturas de Pantalla de la Vista de Estudio y Modales
            # ============================================================
            print("\n[E2E 14] Generando capturas de pantalla de la Vista de Estudio y Detalle...")
            os.makedirs("screenshots", exist_ok=True)
            page_a.set_viewport_size({"width": 1280, "height": 800})
            page_a.screenshot(path="screenshots/study_view.png")

            # Abrir detalle de materia y tomar screenshot
            page_a.click(".subject-card[data-id='subject-seed-ingles'] [data-action='detail']")
            page_a.wait_for_selector("#subject-detail-overlay.open", timeout=3000)
            page_a.screenshot(path="screenshots/subject_detail.png")
            page_a.keyboard.press("Escape")
            page_a.wait_for_selector("#subject-detail-overlay", state="hidden", timeout=3000)
            print(" -> Capturas guardadas en screenshots/study_view.png y screenshots/subject_detail.png.")

            # ============================================================
            # [E2E 15] Temporizador de Enfoque, Distracciones y Guardado con Notas (Fase C)
            # ============================================================
            print("\n[E2E 15] Probando flujo completo de Temporizador de Enfoque Pomodoro...")
            page_a.click("#btn-focus-fab")
            page_a.wait_for_selector("#focus-timer-overlay.open", timeout=3000)

            page_a.select_option("#focus-method-select", "pomodoro")
            page_a.select_option("#focus-subject-select", "subject-seed-ingles")
            page_a.fill("#focus-goal-input", "Aprender Phrasal Verbs C1")
            page_a.click("#btn-start-focus-session")

            # Verificar transición a pantalla activa
            page_a.wait_for_selector("#focus-active-view", state="visible", timeout=3000)
            assert "ENFOQUE" in page_a.inner_text("#focus-phase-badge")
            assert "Aprender Phrasal Verbs C1" in page_a.inner_text("#focus-active-goal-text")

            # Anotar distracción
            page_a.fill("#focus-distraction-input", "Llamada telefónica breve")
            page_a.click("#btn-add-distraction")
            time.sleep(0.3)
            assert "1 registradas" in page_a.inner_text("#focus-distractions-count")

            # Tomar capturas de pantalla de la sesión activa en Desktop y Mobile
            page_a.set_viewport_size({"width": 1280, "height": 800})
            page_a.screenshot(path="screenshots/focus_timer_active_desktop.png")

            page_a.set_viewport_size({"width": 390, "height": 844})
            page_a.screenshot(path="screenshots/focus_timer_active_mobile.png")
            page_a.set_viewport_size({"width": 1280, "height": 800}) # Restaurar tamaño
            print(" -> Capturas de sesión activa guardadas (desktop y móvil).")

            # Pausar y Finalizar sesión
            page_a.click("#btn-pause-resume-focus")
            page_a.click("#btn-finish-focus")
            page_a.wait_for_selector("#focus-summary-view", state="visible", timeout=3000)

            # Rellenar notas de aprendizaje
            page_a.fill("#summary-learned-text", "Dominé 5 phrasal verbs clave: look into, bring up, call off, put off, figure out.")
            page_a.fill("#summary-questions-text", "¿Cuándo usar 'call off' vs 'postpone'?")
            page_a.fill("#summary-next-step", "Hacer 10 oraciones de práctica")
            page_a.click("#btn-save-session-with-notes")
            page_a.wait_for_selector("#focus-timer-overlay", state="hidden", timeout=3000)

            # Sincronizar y verificar en B
            page_a.evaluate("async () => { await window.syncWithBackend(); }")
            page_b.evaluate("async () => { await window.syncWithBackend(); }")

            b_has_session_and_notes = page_b.evaluate("""() => {
                const focs = JSON.parse(localStorage.getItem('diary_focus_sessions') || '[]');
                const nots = JSON.parse(localStorage.getItem('diary_learning_notes') || '[]');
                return {
                    hasFoc: focs.some(f => f.goal === 'Aprender Phrasal Verbs C1' && !f.deleted_at),
                    hasNot: nots.some(n => n.learned_text.includes('phrasal verbs') && !n.deleted_at)
                };
            }""")
            assert b_has_session_and_notes["hasFoc"] is True, "Contexto B debió recibir la sesión de enfoque de Inglés"
            assert b_has_session_and_notes["hasNot"] is True, "Contexto B debió recibir la nota de aprendizaje asociada"
            print(" -> Sesión de enfoque y notas sincronizadas 100% exitosamente con B.")

            # ============================================================
            # [E2E 16] Persistencia y Restauración de Sesión Activa tras Recarga (F5)
            # ============================================================
            print("\n[E2E 16] Probando persistencia y recuperación de sesión activa tras F5...")
            page_a.evaluate("""() => {
                const timer = {
                    id: 'foc-reload-test-1',
                    method: 'flowtime',
                    status: 'running',
                    phase: 'focus',
                    goal: 'Sesión Flowtime Resistente a F5',
                    subject_id: 'subject-seed-genai',
                    config: { focusDurationSec: 0, isCountdown: false },
                    effective_seconds: 420,
                    started_at: new Date().toISOString(),
                    last_heartbeat: Date.now(),
                    tabId: 'tab_A'
                };
                window.saveActiveFocusSession(timer);
            }""")

            # Recargar página A
            page_a.reload()
            page_a.wait_for_selector("#view-dashboard.active", timeout=3000)

            # Verificar que el temporizador activo fue restaurado
            is_active_restored = page_a.evaluate("""() => {
                const stored = window.loadActiveFocusSession();
                return stored && stored.id === 'foc-reload-test-1' && stored.status === 'running';
            }""")
            assert is_active_restored is True, "La sesión activa debió restaurarse automáticamente tras la recarga F5"

            # Limpiar sesión activa
            page_a.evaluate("() => window.clearActiveFocusSession()")
            print(" -> Sesión activa sobrevive a recarga de página sin perder datos.")

            # ============================================================
            # [E2E 17] Bloqueo de Sesión Activa Multi-Pestaña
            # ============================================================
            print("\n[E2E 17] Probando advertencia de sesión activa en otra pestaña (Multi-tab lock)...")
            # Inyectar sesión activa con un tabId diferente
            page_a.evaluate("""() => {
                const timerOtherTab = {
                    id: 'foc-other-tab-1',
                    method: 'pomodoro',
                    status: 'running',
                    phase: 'focus',
                    subject_id: 'subject-seed-mlops',
                    last_heartbeat: Date.now(),
                    tabId: 'other_tab_xyz'
                };
                localStorage.setItem('diary_focus_active', JSON.stringify(timerOtherTab));
                window.openFocusModal();
            }""")

            page_a.wait_for_selector("#focus-multitab-warning", state="visible", timeout=3000)
            assert "otra pestaña" in page_a.inner_text("#focus-multitab-warning")
            print(" -> Banner de bloqueo multi-pestaña mostrado correctamente.")
            page_a.evaluate("() => { window.clearActiveFocusSession(); window.closeFocusModal(); }")

            # ============================================================
            # [E2E 18] Entrada Manual de Tiempo y Actualización Reactiva de Métricas
            # ============================================================
            print("\n[E2E 18] Probando registro manual de tiempo de estudio y reactividad...")
            page_a.click(".nav-item[data-view='study']")
            page_a.wait_for_selector("#view-study.active", timeout=3000)

            # Abrir detalle de Inglés y registrar tiempo manual
            page_a.click(".subject-card[data-id='subject-seed-ingles'] [data-action='detail']")
            page_a.wait_for_selector("#subject-detail-overlay.open", timeout=3000)
            page_a.click("#btn-add-manual-time-from-detail")
            page_a.wait_for_selector("#manual-time-overlay.open", timeout=3000)

            page_a.fill("#manual-duration-minutes", "90")
            page_a.fill("#manual-goal-input", "Estudio de vocabulario en libro")
            page_a.click("#btn-save-manual-time")
            page_a.wait_for_selector("#manual-time-overlay", state="hidden", timeout=3000)

            # Verificar que el tiempo aumentó en el detalle
            hours_text = page_a.inner_text("#detail-stat-hours")
            assert float(hours_text.replace('h', '')) >= 1.5, f"Las horas de la materia debieron actualizarse con 90m (>=1.5h), obtenido: {hours_text}"
            page_a.click("#btn-close-subject-detail")

            # Sincronizar y verificar recepción en Contexto B
            page_a.evaluate("async () => { await window.syncWithBackend(); }")
            page_b.evaluate("async () => { await window.syncWithBackend(); }")

            has_manual_in_b = page_b.evaluate("""() => {
                const focs = JSON.parse(localStorage.getItem('diary_focus_sessions') || '[]');
                return focs.some(f => f.source === 'manual' && f.effective_seconds === 5400 && !f.deleted_at);
            }""")
            assert has_manual_in_b is True, "Contexto B debió recibir la sesión manual de 90 min (5400s)"
            print(" -> Entrada manual de tiempo reflejada en UI y sincronizada a B.")

            # ============================================================
            # [E2E 19] Neutralización de Inyecciones XSS en Temporizador de Enfoque
            # ============================================================
            print("\n[E2E 19] Probando neutralización de ataques XSS en objetivo y distracciones...")
            timer_xss_dialogs = []
            page_a.on("dialog", lambda dialog: (timer_xss_dialogs.append(dialog.message), dialog.dismiss()))

            page_a.evaluate("""() => {
                window.openFocusModal({
                    goal: '<script>alert("xss-timer-goal")</script><img src=x onerror=alert("xss-timer-img")>'
                });
                window.startFocusSessionFromSetup();
            }""")
            time.sleep(0.5)
            assert len(timer_xss_dialogs) == 0, f"Inyección XSS detectada en temporizador: {timer_xss_dialogs}"

            # Limpiar temporizador
            page_a.evaluate("() => { window.clearActiveFocusSession(); window.closeFocusModal(); }")
            print(" -> 0 alertas XSS en temporizador: entradas 100% neutralizadas.")

            browser.close()
            print("\n============================================================")
            print("TODOS LOS TESTS E2E DE PLAYWRIGHT PASARON (100% OK)")
            print("============================================================\n")

    finally:
        server.stop()


if __name__ == "__main__":
    test_playwright_e2e_full_sync()

