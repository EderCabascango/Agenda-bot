"""E2E: login con Google, perfil y dashboard sin materias.

1. Sin sesión se muestra la pantalla de login y la app queda oculta.
2. Una sesión caducada también lleva al login.
3. El dashboard no muestra la tarjeta de materias aunque existan materias y sesiones.
4. El perfil del servidor se refleja en saludo, nombre, rol e iniciales del avatar.
5. Editar el perfil desde Ajustes lo guarda en el servidor y actualiza el topbar.
6. Cerrar sesión borra la sesión local y vuelve al login sin borrar los datos.
"""
import json
import time
import urllib.request
from datetime import datetime, timedelta

from playwright.sync_api import sync_playwright
from test_server import TestServerRunner


def api(server, method, path, body=None):
    req = urllib.request.Request(
        f"{server.url}{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={**server.auth_headers, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=5) as res:
        return json.loads(res.read())


def block_google(page):
    # Los tests no dependen de internet: el script de Google Sign-In se bloquea.
    page.route("https://accounts.google.com/**", lambda route: route.abort())


def run():
    print("Testing login con Google, perfil y dashboard sin materias...")
    server = TestServerRunner().start()

    try:
        with sync_playwright() as p:
            # ── 1 y 2. Sin sesión / sesión caducada → login ──
            raw_browser = p.chromium.launch(headless=True)
            page = raw_browser.new_page()
            block_google(page)
            page.goto(f"{server.url}/?e2e=1")
            page.wait_for_selector('#login-screen:not([hidden])')
            assert not page.is_visible('#app-wrapper'), "La app debe estar oculta sin sesión"
            page.wait_for_selector('#login-error:not([hidden])')
            print(f"  [OK] Sin sesión: login visible. Mensaje: {page.text_content('#login-error').strip()}")

            expired = {**server.session, "expires_at": "2000-01-01T00:00:00Z"}
            page.evaluate(f"() => localStorage.setItem('diary_session', JSON.stringify({json.dumps(expired)}))")
            page.reload()
            page.wait_for_selector('#login-screen:not([hidden])')
            assert not page.is_visible('#app-wrapper')
            print("  [OK] Sesión caducada: vuelve al login.")

            # ── 6. Cerrar sesión (con sesión válida inyectada a mano) ──
            page.evaluate(f"() => {{ localStorage.setItem('diary_session', JSON.stringify({json.dumps(server.session)})); localStorage.setItem('diary_sentinel', 'datos-locales'); }}")
            page.reload()
            page.wait_for_selector('#app-wrapper', state='visible')
            page.click('.nav-item[data-view="settings"]')
            page.click('#btn-logout')
            page.wait_for_selector('#login-screen:not([hidden])')
            state = page.evaluate("() => ({ session: localStorage.getItem('diary_session'), sentinel: localStorage.getItem('diary_sentinel') })")
            assert state['session'] is None, "Cerrar sesión debe borrar la sesión local"
            assert state['sentinel'] == 'datos-locales', "Cerrar sesión no debe borrar los datos locales"
            print("  [OK] Cerrar sesión: vuelve al login y conserva los datos locales.")
            raw_browser.close()

            # ── 3, 4 y 5. Con sesión ──
            api(server, "PUT", "/profile", {"first_name": "Wladimir", "last_name": "Eder", "role": "Estudiante"})

            browser = server.launch_browser(p)
            page = browser.new_page(viewport={'width': 1280, 'height': 900})
            page.goto(f"{server.url}/?e2e=1")
            page.wait_for_load_state("networkidle")

            mon_str = (datetime.now() - timedelta(days=datetime.now().weekday())).strftime('%Y-%m-%d')
            page.evaluate(f"""() => {{
                localStorage.setItem('diary_subjects', JSON.stringify([
                    {{ id: 'sub-1', name: 'Inglés', color: '#3B82F6', archived: false, deleted_at: null }}
                ]));
                localStorage.setItem('diary_focus_sessions', JSON.stringify([
                    {{ id: 's1', subject_id: 'sub-1', started_at: '{mon_str}T08:00:00.000Z', effective_seconds: 3600, duration_minutes: 60, status: 'completed', created_at: '{mon_str}T08:00:00.000Z' }}
                ]));
            }}""")
            page.reload()
            page.wait_for_load_state("networkidle")
            page.wait_for_function("() => document.querySelector('#user-avatar').textContent.trim() === 'WE'")

            assert page.locator('#db-subjects-summary-card').count() == 0, "La tarjeta de materias no debe estar en el dashboard"
            subtext = page.text_content('#greeting-subtext')
            assert 'materia' not in subtext.lower(), f"El saludo no debe hablar de materias: {subtext!r}"
            print(f"  [OK] Dashboard sin materias. Subtítulo: {subtext!r}")

            assert page.text_content('#greeting-text').strip() == '¡Hola, Wladimir!'
            assert page.text_content('#topbar-username').strip() == 'Wladimir Eder'
            assert page.text_content('#topbar-role').strip() == 'Estudiante'
            print("  [OK] Perfil del servidor en saludo, nombre, rol e iniciales 'WE'.")

            page.click('.nav-item[data-view="settings"]')
            page.wait_for_selector('#profile-first-name', state='visible')
            assert page.input_value('#profile-first-name') == 'Wladimir'
            page.fill('#profile-first-name', 'Ana')
            page.fill('#profile-last-name', 'López')
            page.fill('#profile-role', 'Ingeniera de datos')
            page.click('#btn-save-profile')
            page.wait_for_function("() => document.querySelector('#topbar-username').textContent.trim() === 'Ana López'")
            assert page.text_content('#user-avatar').strip() == 'AL'
            assert page.text_content('#topbar-role').strip() == 'Ingeniera de datos'
            saved = api(server, "GET", "/profile")
            assert (saved['first_name'], saved['last_name'], saved['role']) == ('Ana', 'López', 'Ingeniera de datos'), saved
            print("  [OK] Perfil editado desde Ajustes, guardado en el servidor y reflejado en el topbar.")

            browser.close()
            print("Login y perfil: verificación PASSED 100%!")
    finally:
        server.stop()


if __name__ == '__main__':
    run()
