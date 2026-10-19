"""E2E: módulo de ejercicio (calistenia).

1. Crear una rutina desde la interfaz (la medida se detecta: Plancha = segundos).
2. Empezar la rutina: series objetivo precargadas; registrar y guardar -> llega al servidor.
3. Segundo entreno: muestra "La última vez" y precarga el lastre usado.
4. Progreso: récords (mejor serie, lastre, 1RM) y gráfica semanal.
5. La fila "Ejercicio" de la matriz queda hecha hoy.
6. Entrenar desde una actividad de la agenda la marca como completada (local y servidor).
7. El borrador sobrevive a recargar la página.
8. Eliminar un entreno pide confirmación y se borra también en el servidor.
"""
import json
import urllib.request
from datetime import datetime

from playwright.sync_api import sync_playwright
from test_server import TestServerRunner

TODAY = datetime.now().strftime('%Y-%m-%d')
MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']


def api(server, method, path, body=None):
    req = urllib.request.Request(
        f"{server.url}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={**server.auth_headers, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.loads(res.read())


def server_collection(server, name):
    res = api(server, "POST", "/sync", {"since": None, "full_pull": True, "collections": {name: []}})
    return res["results"][name]["changes"]


def wait_synced(page):
    page.wait_for_function("() => JSON.parse(localStorage.getItem('diary_sync_queue') || '[]').length === 0", timeout=15000)


def run():
    print("Testing módulo de ejercicio (calistenia)...")
    server = TestServerRunner().start()

    try:
        api(server, "POST", "/sync", {"since": None, "collections": {"activities": [
            {"id": "act-cali", "title": "Calistenia", "date": TODAY, "startTime": "23:00", "endTime": "23:50", "tags": ["salud", "ejercicio"]}
        ]}})

        with sync_playwright() as p:
            browser = server.launch_browser(p)
            page = browser.new_page(viewport={'width': 1280, 'height': 900})
            page.goto(f"{server.url}/?e2e=1")
            page.wait_for_load_state("networkidle")
            page.wait_for_function("() => JSON.parse(localStorage.getItem('diary_activities') || '[]').some(a => a.id === 'act-cali')")

            # ── 1. Crear rutina ──
            page.click('.nav-item[data-view="workout"]')
            page.click('[data-workout-tab="routines"]')
            page.click('#btn-new-routine')
            page.fill('#routine-editor-name', 'Empuje')
            rows = '#routine-editor-exercises [data-row]'
            page.fill(f'{rows}:nth-child(1) input[data-field="name"]', 'Fondos')
            page.fill(f'{rows}:nth-child(1) input[data-field="target_sets"]', '4')
            page.click('#btn-routine-add-exercise')
            page.fill(f'{rows}:nth-child(2) input[data-field="name"]', 'Plancha')
            page.press(f'{rows}:nth-child(2) input[data-field="name"]', 'Tab')
            page.wait_for_function("() => document.querySelector('#routine-editor-exercises [data-row=\"1\"] select[data-field=\"measure\"]').value === 'time'")  # Plancha = isométrico
            page.fill(f'{rows}:nth-child(2) input[data-field="target_seconds"]', '45')
            page.click('#routine-editor-save')
            page.wait_for_selector('#routine-editor-overlay:not(.open)', state='attached')
            wait_synced(page)
            routines = server_collection(server, 'workout_routines')
            assert len(routines) == 1 and routines[0]['name'] == 'Empuje'
            assert routines[0]['exercises'][0]['target_sets'] == 4
            assert routines[0]['exercises'][1] == {'name': 'Plancha', 'measure': 'time', 'target_sets': 3, 'target_reps': 0, 'target_seconds': 45}
            print("  [OK] Rutina creada y sincronizada (Plancha detectada como isométrico).")

            # ── 2. Primer entreno ──
            page.click('[data-workout-tab="train"]')
            page.click('[data-start-routine]')
            page.wait_for_selector('#workout-overlay.open')
            ex1 = '#workout-exercises [data-ex="0"]'
            assert page.locator(f'{ex1} [data-set]').count() == 4, "Se precargan las 4 series objetivo"
            assert page.input_value(f'{ex1} [data-set="0"] input[data-field="reps"]') == '10'
            page.fill(f'{ex1} [data-set="0"] input[data-field="reps"]', '12')
            page.fill(f'{ex1} [data-set="0"] input[data-field="weight_kg"]', '5')
            page.fill('#workout-duration', '40')
            page.click('#workout-save')
            page.wait_for_selector('#workout-overlay:not(.open)', state='attached')
            wait_synced(page)
            saved = server_collection(server, 'workouts')
            assert len(saved) == 1 and saved[0]['duration_minutes'] == 40
            assert saved[0]['exercises'][0]['sets'][0] == {'reps': 12, 'seconds': 0, 'weight_kg': 5.0}
            assert saved[0]['exercises'][1]['sets'][0]['seconds'] == 45
            print("  [OK] Entreno registrado desde la rutina y sincronizado.")

            # ── 3. Segundo entreno: "La última vez" ──
            page.click('[data-start-routine]')
            page.wait_for_selector('#workout-overlay.open')
            last = page.text_content(f'{ex1} .workout-last')
            assert 'La última vez' in last and '12@+5kg' in last, last
            assert page.input_value(f'{ex1} [data-set="0"] input[data-field="weight_kg"]') == '5', "Se precarga el lastre de la última vez"
            page.click('#workout-cancel')
            page.wait_for_selector('#confirm-action-overlay.open')
            page.click('#confirm-action-ok')
            print("  [OK] El siguiente entreno muestra la última vez y precarga el lastre.")

            # ── 4. Progreso ──
            page.click('[data-workout-tab="progress"]')
            page.wait_for_selector('#workout-records table')
            records = page.text_content('#workout-records')
            assert 'Fondos' in records and '12 reps' in records and '+5 kg' in records and '+7 kg' in records, records
            assert 'Plancha' in records and '45 s' in records
            assert page.locator('#workout-progress-chart rect.workout-bar').count() == 1
            print("  [OK] Récords (12 reps, +5 kg, 1RM +7 kg) y gráfica semanal.")

            # ── 5. Matriz ──
            page.click('.nav-item[data-view="dashboard"]')
            today = datetime.now()
            label = f"Ejercicio, {today.day} {MONTHS[today.month - 1]}"
            cell = page.evaluate(f"""() => {{ const c = [...document.querySelectorAll('.diario-table .act-cell')]
                .find(c => (c.getAttribute('aria-label') || '').startsWith({json.dumps(label)})); return c ? c.className : null; }}""")
            assert cell and 'done' in cell, f"La fila Ejercicio de hoy debe estar hecha: {cell}"
            print("  [OK] La fila 'Ejercicio' de la matriz queda hecha hoy.")

            # ── 6. Desde la agenda ──
            page.click('[data-agenda-workout="act-cali"]')
            page.wait_for_selector('#workout-overlay.open')
            assert 'Calistenia' in page.text_content('#workout-linked-activity')
            page.fill('#workout-exercises [data-ex="0"] input[data-field="name"]', 'Dominadas')
            page.press('#workout-exercises [data-ex="0"] input[data-field="name"]', 'Tab')
            page.fill('#workout-exercises [data-ex="0"] [data-set="0"] input[data-field="reps"]', '8')
            page.click('#workout-save')
            wait_synced(page)
            assert page.evaluate("() => JSON.parse(localStorage.getItem('diary_activities')).find(a => a.id === 'act-cali').completed") is True
            server_act = [a for a in api(server, "GET", "/activities") if a['id'] == 'act-cali'][0]
            assert server_act['completed'] is True
            linked = [w for w in server_collection(server, 'workouts') if w.get('activity_id') == 'act-cali']
            assert len(linked) == 1 and linked[0]['routine_id'] is None
            print("  [OK] Entrenar desde la agenda marca la actividad como completada (también en el servidor).")

            # ── 7. Borrador tras recargar ──
            page.click('.nav-item[data-view="workout"]')
            page.click('#btn-workout-free')
            page.wait_for_selector('#workout-overlay.open')
            page.fill('#workout-exercises [data-ex="0"] input[data-field="name"]', 'Flexiones')
            page.fill('#workout-exercises [data-ex="0"] [data-set="0"] input[data-field="reps"]', '25')
            page.reload()
            page.wait_for_load_state("networkidle")
            page.click('.nav-item[data-view="workout"]')
            page.click('#btn-workout-free')
            page.wait_for_selector('#workout-overlay.open')
            assert page.input_value('#workout-exercises [data-ex="0"] input[data-field="name"]') == 'Flexiones'
            assert page.input_value('#workout-exercises [data-ex="0"] [data-set="0"] input[data-field="reps"]') == '25'
            page.click('#workout-close')
            print("  [OK] El entreno a medias sobrevive a recargar la página.")

            # ── 8. Eliminar entreno ──
            page.click('[data-workout-tab="train"]')
            page.click('#workout-recent-list details:first-child summary')
            page.click('#workout-recent-list details:first-child [data-delete-workout]')
            page.wait_for_selector('#confirm-action-overlay.open')
            page.click('#confirm-action-ok')
            wait_synced(page)
            remaining = [w for w in server_collection(server, 'workouts') if not w['deleted_at']]
            assert len(remaining) == 1, f"Debe quedar 1 entreno activo en el servidor, hay {len(remaining)}"
            print("  [OK] Eliminar un entreno pide confirmación y se borra en el servidor.")

            browser.close()
            print("Módulo de ejercicio: verificación PASSED 100%!")
    finally:
        server.stop()


if __name__ == '__main__':
    run()
