"""E2E: rutina base solo bajo demanda (y sincronizada) y materias en la paleta Taskly.

1. Una sesión nueva sin actividades NO carga la rutina base automáticamente.
2. Ajustes → "Restaurar" carga la rutina en la semana actual y la sube al servidor.
3. Volver a cargarla reemplaza la de la semana (tombstones) en vez de duplicarla.
4. Las tarjetas de materias solo usan negro, blanco, grises y ámbar aunque la materia
   tenga guardado un color antiguo, y el formulario ya no tiene selector de color.
"""
import json
import urllib.request
from datetime import datetime, timedelta

from playwright.sync_api import sync_playwright
from test_matrix_redesign import is_allowed_color, parse_rgba
from test_server import TestServerRunner


def api(server, method, path, body=None):
    req = urllib.request.Request(
        f"{server.url}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={**server.auth_headers, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.loads(res.read())


def week_range():
    today = datetime.now()
    monday = today - timedelta(days=today.weekday())
    return monday.strftime('%Y-%m-%d'), (monday + timedelta(days=6)).strftime('%Y-%m-%d')


def server_week_activities(server):
    start, end = week_range()
    return api(server, "GET", f"/activities?start={start}&end={end}")


def run():
    print("Testing rutina base bajo demanda y materias en la paleta...")
    server = TestServerRunner().start()
    start, end = week_range()

    try:
        with sync_playwright() as p:
            browser = server.launch_browser(p)
            page = browser.new_page(viewport={'width': 1280, 'height': 900})
            page.on("dialog", lambda d: d.accept())
            page.goto(f"{server.url}/?e2e=1")
            page.wait_for_load_state("networkidle")
            page.wait_for_function("() => !!localStorage.getItem('diary_last_sync')")

            # ── 1. Sin carga automática ──
            local_week = page.evaluate(f"""() => JSON.parse(localStorage.getItem('diary_activities') || '[]')
                .filter(a => !a.deleted_at && a.date >= '{start}' && a.date <= '{end}').length""")
            assert local_week == 0, f"La rutina base no debe cargarse sola; hay {local_week} actividades esta semana"
            assert server_week_activities(server) == []
            print("  [OK] Sesión nueva: la rutina base no se carga automáticamente.")

            # ── 2. Cargar con el botón y sincronizar ──
            page.click('.nav-item[data-view="settings"]')
            page.click('#btn-restore-routine')
            page.wait_for_selector('#confirm-action-overlay.open')
            page.click('#confirm-action-ok')
            page.wait_for_function("() => JSON.parse(localStorage.getItem('diary_sync_queue') || '[]').length === 0", timeout=15000)
            first = server_week_activities(server)
            titles = {a['title'] for a in first}
            assert len(first) > 50 and {'Dormir', 'Inglés', 'Planificación'} <= titles, f"Rutina incompleta en el servidor: {len(first)}"
            print(f"  [OK] Rutina base cargada con el botón y sincronizada: {len(first)} actividades en el servidor.")

            # ── 3. Recargar reemplaza, no duplica ──
            page.click('#btn-restore-routine')
            page.wait_for_selector('#confirm-action-overlay.open')
            page.click('#confirm-action-ok')
            page.wait_for_function("() => JSON.parse(localStorage.getItem('diary_sync_queue') || '[]').length === 0", timeout=15000)
            second = server_week_activities(server)
            assert len(second) == len(first), f"Recargar debe reemplazar ({len(first)}), no duplicar ({len(second)})"
            assert not ({a['id'] for a in first} & {a['id'] for a in second}), "Las actividades anteriores deben quedar como tombstones"
            local_week = page.evaluate(f"""() => JSON.parse(localStorage.getItem('diary_activities') || '[]')
                .filter(a => !a.deleted_at && a.date >= '{start}' && a.date <= '{end}').length""")
            assert local_week == len(second)
            print("  [OK] Recargar la rutina reemplaza la semana en local y en el servidor sin duplicar.")

            # ── 4. Materias en la paleta ──
            api(server, "POST", "/sync", {"since": None, "collections": {"subjects": [
                {"id": "sub-morado", "name": "Morado antiguo", "color": "#8B5CF6"},
                {"id": "sub-verde", "name": "Verde antiguo", "color": "#10B981"},
                {"id": "sub-azul", "name": "Azul antiguo", "color": "#3B82F6"},
            ]}})
            for theme in ['light', 'dark']:
                page.evaluate(f"() => {{ localStorage.setItem('diary_theme', '{theme}'); localStorage.setItem('diary_last_sync', '1970-01-01T00:00:00Z'); }}")
                page.reload()
                page.wait_for_load_state("networkidle")
                page.click('.nav-item[data-view="study"]')
                page.wait_for_selector('.subject-card[data-id="sub-morado"]')
                colors = page.evaluate("""() => [...document.querySelectorAll('.subject-card')].flatMap(card => {
                    const icon = card.querySelector('.subject-card-icon');
                    const fill = card.querySelector('.subject-progress-fill');
                    return [getComputedStyle(card).borderTopColor, icon && getComputedStyle(icon).backgroundColor,
                            fill && getComputedStyle(fill).backgroundColor].filter(Boolean);
                })""")
                for c in colors:
                    rgba = parse_rgba(c)
                    if rgba:
                        allowed, reason = is_allowed_color(*rgba)
                        assert allowed, f"[{theme}] color fuera de la paleta en materias: {c} ({reason})"
                print(f"  [OK] [{theme}] {len(colors)} colores de tarjetas de materias dentro de la paleta.")

            page.evaluate("() => window.openSubjectModal && window.openSubjectModal()")
            assert page.locator('#subject-color-picker, #subject-color-input').count() == 0, "El formulario no debe tener selector de color"
            print("  [OK] El formulario de materia ya no tiene selector de color.")

            browser.close()
            print("Rutina base y paleta: verificación PASSED 100%!")
    finally:
        server.stop()


if __name__ == '__main__':
    run()
