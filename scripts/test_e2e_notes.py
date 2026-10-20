"""E2E: sección Apuntes.

1. Crear un apunte con texto, tareas (agregar con Enter, reordenar), etiquetas, día y fijado -> llega al servidor.
2. Buscar sin tildes y filtrar por etiqueta.
3. Marcar una tarea desde la tarjeta (sin abrir el editor) se sincroniza.
4. El calendario muestra los "Apuntes del día" y permite crear uno con esa fecha; la Agenda de Hoy enlaza a los de hoy.
5. Un apunte vacío no se guarda; eliminar pide confirmación y borra en el servidor.
"""
import json
import urllib.request
from datetime import datetime

from playwright.sync_api import sync_playwright
from test_server import TestServerRunner

TODAY = datetime.now().strftime('%Y-%m-%d')


def server_notes(server):
    req = urllib.request.Request(
        f"{server.url}/sync", method="POST",
        data=json.dumps({"since": None, "full_pull": True, "collections": {"notes": []}}).encode(),
        headers={**server.auth_headers, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as res:
        return [n for n in json.loads(res.read())["results"]["notes"]["changes"] if not n["deleted_at"]]


def wait_synced(page):
    page.wait_for_function("() => JSON.parse(localStorage.getItem('diary_sync_queue') || '[]').length === 0", timeout=15000)


def run():
    print("Testing Apuntes...")
    server = TestServerRunner().start()
    try:
        with sync_playwright() as p:
            browser = server.launch_browser(p)
            page = browser.new_page(viewport={'width': 1280, 'height': 900})
            page.goto(f"{server.url}/?e2e=1")
            page.wait_for_load_state("networkidle")

            # ── 1. Crear apunte completo ──
            page.click('.nav-item[data-view="notes"]')
            page.click('#btn-new-note')
            page.wait_for_selector('#note-editor-overlay.open')
            page.fill('#note-editor-title', 'Compras del finde')
            page.fill('#note-editor-content', 'Para el sábado en la mañana')
            for item in ['Pan', 'Leche', 'Frutas']:
                page.fill('#note-editor-new-item', item)
                page.press('#note-editor-new-item', 'Enter')
            page.click('#note-editor-checklist [data-item="1"] [data-item-move="-1"]')  # Leche sube al primer lugar
            page.fill('#note-editor-tags', 'Casa, #compras')
            page.fill('#note-editor-date', TODAY)
            page.click('#note-editor-pin')
            page.click('#note-editor-save')
            wait_synced(page)
            notes = server_notes(server)
            assert len(notes) == 1, notes
            n = notes[0]
            assert [i['text'] for i in n['checklist']] == ['Leche', 'Pan', 'Frutas']
            assert n['tags'] == ['casa', 'compras'] and n['date'] == TODAY and n['pinned'] == 1
            print("  [OK] Apunte con texto, tareas reordenadas, etiquetas, día y fijado guardado en el servidor.")

            # Segundo apunte para búsquedas
            page.click('#btn-new-note')
            page.fill('#note-editor-title', 'Idea: canción para la app')
            page.fill('#note-editor-tags', 'ideas')
            page.click('#note-editor-save')
            wait_synced(page)
            first_card = page.text_content('#notes-list .note-card:first-child h4')
            assert first_card == 'Compras del finde', "los fijados van primero"

            # ── 2. Buscar y filtrar ──
            page.fill('#notes-search', 'CANCION')
            assert page.locator('#notes-list .note-card').count() == 1
            assert 'canción' in page.text_content('#notes-list .note-card h4')
            page.fill('#notes-search', '')
            page.click('[data-note-tag="casa"]')
            assert page.locator('#notes-list .note-card').count() == 1
            page.click('[data-note-tag=""]')
            assert page.locator('#notes-list .note-card').count() == 2
            print("  [OK] Búsqueda sin tildes y filtro por etiqueta.")

            # ── 3. Marcar tarea desde la tarjeta ──
            page.check('#notes-list .note-card:first-child [data-note-check="0"]')
            wait_synced(page)
            assert not page.is_visible('#note-editor-overlay.open'), "marcar no abre el editor"
            compras = [x for x in server_notes(server) if x['title'] == 'Compras del finde'][0]
            assert compras['checklist'][0] == {'text': 'Leche', 'done': True}
            assert '1/3' in page.text_content('#notes-list .note-card:first-child .note-progress')
            print("  [OK] Marcar una tarea desde la tarjeta se sincroniza (1/3).")

            # ── 4. Calendario y agenda ──
            page.click('.nav-item[data-view="calendar"]')
            page.wait_for_selector('#cal-day-notes .day-note-item')
            assert 'Apuntes del día (1)' in page.text_content('#cal-day-notes')
            page.click('#cal-day-notes [data-new-note-date]')
            page.wait_for_selector('#note-editor-overlay.open')
            assert page.input_value('#note-editor-date') == TODAY, "el apunte nuevo hereda el día del calendario"
            page.fill('#note-editor-title', 'Llamar al dentista')
            page.click('#note-editor-save')
            wait_synced(page)
            assert 'Apuntes del día (2)' in page.text_content('#cal-day-notes')
            page.click('.nav-item[data-view="dashboard"]')
            assert 'Apuntes de hoy (2)' in page.text_content('#btn-agenda-notes')
            page.click('#btn-agenda-notes')
            page.wait_for_selector('#view-notes.active')
            assert page.locator('#notes-list .note-card').count() == 2, "solo los de hoy"
            assert not page.is_hidden('#notes-filter-info')
            print("  [OK] Apuntes del día en el calendario y enlace 'Apuntes de hoy' en la agenda.")

            # ── 5. Vacío y eliminar ──
            page.click('#btn-new-note')
            page.click('#note-editor-save')
            assert 'vacío' in page.text_content('#note-editor-errors')
            page.click('#note-editor-cancel')
            page.click('#notes-list .note-card:has-text("Llamar al dentista")')
            page.click('#note-editor-delete')
            page.wait_for_selector('#confirm-action-overlay.open')
            page.click('#confirm-action-ok')
            wait_synced(page)
            assert all(x['title'] != 'Llamar al dentista' for x in server_notes(server))
            assert len(server_notes(server)) == 2
            print("  [OK] Un apunte vacío no se guarda y eliminar pide confirmación y borra en el servidor.")

            browser.close()
            print("Apuntes: verificación PASSED 100%!")
    finally:
        server.stop()


if __name__ == '__main__':
    run()
