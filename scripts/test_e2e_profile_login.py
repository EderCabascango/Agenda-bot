"""E2E: login con correo y contraseña, perfil y dashboard sin materias.

1. El dashboard no muestra la tarjeta de materias aunque existan materias y sesiones.
2. El perfil del servidor se refleja en saludo, nombre, rol e iniciales del avatar.
3. Editar el perfil desde Ajustes lo guarda en el servidor y actualiza el topbar.
4. Sin sesión o con sesión caducada se muestra el login y la app queda oculta.
5. Una contraseña incorrecta muestra error; la correcta entra a la app.
6. Cambiar la contraseña desde Ajustes cierra la sesión del otro dispositivo.
7. Cerrar sesión borra la sesión local y vuelve al login sin borrar los datos.
"""
import json
import urllib.error
import urllib.request
from datetime import datetime, timedelta

from playwright.sync_api import sync_playwright
from test_server import TestServerRunner


def api(server, method, path, body=None, headers=None):
    req = urllib.request.Request(
        f"{server.url}{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={**(headers or server.auth_headers), "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.loads(res.read())


def status_of(server, path, headers):
    try:
        urllib.request.urlopen(urllib.request.Request(f"{server.url}{path}", headers=headers), timeout=10)
        return 200
    except urllib.error.HTTPError as e:
        return e.code


def login_via_form(page, email, password):
    page.fill('#login-email', email)
    page.fill('#login-password', password)
    page.click('#login-submit')


def run():
    print("Testing login con correo y contraseña, perfil y dashboard sin materias...")
    server = TestServerRunner().start()

    try:
        with sync_playwright() as p:
            # ── 1, 2 y 3. Con sesión inyectada ──
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
            assert page.text_content('#profile-email').strip() in ('—', server.email)
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

            # ── 4. Sin sesión / sesión caducada → login ──
            raw_browser = p.chromium.launch(headless=True)
            page = raw_browser.new_page()
            page.goto(f"{server.url}/?e2e=1")
            page.wait_for_selector('#login-screen:not([hidden])')
            assert not page.is_visible('#app-wrapper'), "La app debe estar oculta sin sesión"
            assert not page.is_visible('#fab-add'), "Los botones flotantes no deben verse en el login"

            expired = {**server.session, "expires_at": "2000-01-01T00:00:00Z"}
            page.evaluate(f"() => localStorage.setItem('diary_session', JSON.stringify({json.dumps(expired)}))")
            page.reload()
            page.wait_for_selector('#login-screen:not([hidden])')
            assert not page.is_visible('#app-wrapper')
            print("  [OK] Sin sesión y con sesión caducada se muestra el login.")

            # ── 5. Login con el formulario ──
            login_via_form(page, server.email, 'contraseña-incorrecta')
            page.wait_for_selector('#login-error:not([hidden])')
            error = page.text_content('#login-error').strip()
            assert 'incorrectos' in error, error
            assert not page.is_visible('#app-wrapper')

            login_via_form(page, server.email.upper(), server.password)
            page.wait_for_selector('#app-wrapper', state='visible')
            page.wait_for_function("() => document.querySelector('#user-avatar').textContent.trim() === 'AL'")
            assert page.input_value('#login-password') == '', "La contraseña no debe quedarse en el formulario"
            print(f"  [OK] Contraseña incorrecta: {error!r}. Contraseña correcta: entra a la app.")

            # ── 6. Cambiar contraseña cierra la sesión del otro dispositivo ──
            other_device = {"Authorization": f"Bearer {api(server, 'POST', '/auth/login', {'email': server.email, 'password': server.password}, headers={})['token']}"}
            assert status_of(server, "/profile", other_device) == 200

            page.click('.nav-item[data-view="settings"]')
            page.wait_for_selector('#password-current', state='visible')
            page.fill('#password-current', server.password)
            page.fill('#password-new', 'clave-nueva-2026')
            page.fill('#password-confirm', 'otra-distinta')
            page.click('#btn-change-password')
            page.wait_for_selector('#password-status:not([hidden])')
            assert 'no coincide' in page.text_content('#password-status')

            page.fill('#password-confirm', 'clave-nueva-2026')
            page.click('#btn-change-password')
            page.wait_for_function("() => document.querySelector('#password-current').value === ''")
            assert status_of(server, "/profile", other_device) == 401, "La sesión del otro dispositivo debe cerrarse"
            new_token = page.evaluate("() => JSON.parse(localStorage.getItem('diary_session')).token")
            assert status_of(server, "/profile", {"Authorization": f"Bearer {new_token}"}) == 200, "Este dispositivo sigue con sesión"
            print("  [OK] Contraseña cambiada: este dispositivo sigue dentro y el otro queda fuera.")

            # ── 7. Cerrar sesión ──
            page.evaluate("() => localStorage.setItem('diary_sentinel', 'datos-locales')")
            page.click('#btn-logout')
            page.wait_for_selector('#login-screen:not([hidden])')
            state = page.evaluate("() => ({ session: localStorage.getItem('diary_session'), sentinel: localStorage.getItem('diary_sentinel') })")
            assert state['session'] is None, "Cerrar sesión debe borrar la sesión local"
            assert state['sentinel'] == 'datos-locales', "Cerrar sesión no debe borrar los datos locales"
            assert page.input_value('#login-email') == server.email.upper(), "El correo se recuerda para el siguiente login"
            print("  [OK] Cerrar sesión: vuelve al login y conserva los datos locales.")

            login_via_form(page, server.email, 'clave-nueva-2026')
            page.wait_for_selector('#app-wrapper', state='visible')
            print("  [OK] Login con la contraseña nueva.")
            raw_browser.close()

            print("Login y perfil: verificación PASSED 100%!")
    finally:
        server.stop()


if __name__ == '__main__':
    run()
