"""E2E: la app como APK (Capacitor) y sincronización PC ⇄ teléfono.

Simula el APK con window.Capacitor.isNativePlatform() = true:
1. Sin servidor configurado, el login lo pide (y no intenta hablar consigo misma).
2. Con la dirección del servidor, entra y la primera sincronización trae los datos de la PC.
3. Lo que se crea en el teléfono llega a la PC y viceversa al volver a la app (visibilitychange).
4. Dos sincronizaciones pedidas a la vez nunca se solapan (una sola petición /sync en vuelo).
5. Lo creado mientras una sincronización está en curso no se pierde.
"""
import json
import time
import urllib.request
from datetime import datetime

from playwright.sync_api import sync_playwright
from test_server import TestServerRunner

NATIVE_SHIM = "window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };"
TODAY = datetime.now().strftime('%Y-%m-%d')


def api(server, method, path, body=None):
    req = urllib.request.Request(
        f"{server.url}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={**server.auth_headers, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.loads(res.read())


def has_activity(page, title):
    return page.evaluate(f"""() => JSON.parse(localStorage.getItem('diary_activities') || '[]')
        .some(a => a.title === {json.dumps(title)} && !a.deleted_at)""")


def come_back(page):
    page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")


def run():
    print("Testing APK (Capacitor) y sincronización PC <-> teléfono...")
    server = TestServerRunner().start()

    try:
        api(server, "POST", "/sync", {"since": None, "collections": {
            "subjects": [{"id": "sub-pc", "name": "Materia creada en la PC"}],
            "activities": [{"id": "act-pc-1", "title": "Actividad de la PC", "date": TODAY, "startTime": "08:00", "endTime": "09:00"}],
        }})

        with sync_playwright() as p:
            # ── Teléfono (APK simulado), sin sesión ──
            phone_browser = p.chromium.launch(headless=True)
            phone_ctx = phone_browser.new_context(viewport={'width': 390, 'height': 844})
            phone_ctx.add_init_script(NATIVE_SHIM)
            phone = phone_ctx.new_page()
            phone.goto(f"{server.url}/?e2e=1")
            phone.wait_for_selector('#login-screen:not([hidden])')
            assert 'servidor' in phone.text_content('#login-error').lower()
            assert phone.evaluate("() => document.querySelector('.login-server').open"), "Debe abrirse el campo Servidor"

            phone.fill('#login-email', server.email)
            phone.fill('#login-password', server.password)
            phone.click('#login-submit')
            assert 'servidor' in phone.text_content('#login-error').lower(), "Sin servidor no debe intentar entrar"
            print("  [OK] APK sin servidor: el login pide la dirección del servidor.")

            # ── 1 y 2. Configura el servidor y entra ──
            phone.fill('#login-backend-url', server.url + '/')
            phone.click('#login-submit')
            phone.wait_for_selector('#app-wrapper', state='visible')
            phone.wait_for_function("() => JSON.parse(localStorage.getItem('diary_subjects') || '[]').some(s => s.id === 'sub-pc')")
            assert has_activity(phone, 'Actividad de la PC')
            assert phone.evaluate("() => JSON.parse(localStorage.getItem('diary_settings')).backendUrl") == server.url + '/'
            print("  [OK] Con la dirección del servidor entra y trae los datos de la PC.")

            # ── PC (navegador con sesión) ──
            pc_browser = server.launch_browser(p)
            pc = pc_browser.new_page(viewport={'width': 1280, 'height': 900})
            pc.goto(f"{server.url}/?e2e=1")
            pc.wait_for_load_state("networkidle")
            pc.wait_for_function("() => !!localStorage.getItem('diary_last_sync')")

            # ── 3a. Teléfono → PC ──
            phone.click('#fab-add')
            phone.wait_for_selector('#form-title', state='visible')
            phone.fill('#form-title', 'Creada en el teléfono')
            phone.fill('#form-date', TODAY)
            phone.fill('#form-start', '19:00')
            phone.click('#activity-form button[type="submit"]')
            phone.wait_for_function("() => JSON.parse(localStorage.getItem('diary_sync_queue') || '[]').length === 0", timeout=15000)
            assert any(a['title'] == 'Creada en el teléfono' for a in api(server, "GET", "/activities"))
            come_back(pc)
            pc.wait_for_function("() => JSON.parse(localStorage.getItem('diary_activities') || '[]').some(a => a.title === 'Creada en el teléfono')", timeout=15000)
            print("  [OK] Lo creado en el teléfono llega al servidor y a la PC.")

            # ── 3b. PC → teléfono ──
            pc.evaluate(f"""async () => {{
                const acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
                const q = JSON.parse(localStorage.getItem('diary_sync_queue') || '[]');
                const nueva = {{ id: 'act-pc-2', title: 'Creada en la PC', date: '{TODAY}', startTime: '20:00', endTime: '21:00',
                                 tags: [], completed: false, version: 1, updated_at: new Date().toISOString() }};
                acts.push(nueva); q.push({{ ...nueva, collection: 'activities' }});
                localStorage.setItem('diary_activities', JSON.stringify(acts));
                localStorage.setItem('diary_sync_queue', JSON.stringify(q));
                await window.syncWithBackend();
            }}""")
            come_back(phone)
            phone.wait_for_function("() => JSON.parse(localStorage.getItem('diary_activities') || '[]').some(a => a.title === 'Creada en la PC')", timeout=15000)
            print("  [OK] Lo creado en la PC llega al teléfono al volver a la app.")

            # ── 4. Sin sincronizaciones solapadas ──
            spans, open_requests = [], {}
            phone.on("request", lambda r: open_requests.__setitem__(r, time.monotonic()) if r.url.endswith('/sync') else None)
            phone.on("requestfinished", lambda r: spans.append((open_requests.pop(r), time.monotonic())) if r in open_requests else None)
            phone.evaluate("async () => { await Promise.all([window.syncWithBackend(), window.syncWithBackend(), window.syncWithBackend()]); }")
            phone.wait_for_timeout(500)
            spans.sort()
            assert 1 <= len(spans) <= 2, f"3 peticiones simultáneas deben agruparse en 1 o 2 /sync, hubo {len(spans)}"
            for (s1, e1), (s2, _) in zip(spans, spans[1:]):
                assert s2 >= e1, "Las sincronizaciones no deben solaparse"
            print(f"  [OK] 3 sincronizaciones pedidas a la vez -> {len(spans)} petición(es) /sync en serie.")

            # ── 5. Cambio hecho mientras una sincronización está en curso: no se pierde ──
            phone.evaluate("""() => {
                const orig = window.fetch;
                window.fetch = async (...args) => {
                    const res = await orig(...args);
                    if (String(args[0]).endsWith('/sync')) await new Promise(r => setTimeout(r, 1500));
                    return res;
                };
                window.__inflight = window.syncWithBackend();
            }""")
            phone.click('#fab-add')
            phone.wait_for_selector('#form-title', state='visible')
            phone.fill('#form-title', 'Creada durante la sincronización')
            phone.fill('#form-date', TODAY)
            phone.click('#activity-form button[type="submit"]')
            phone.evaluate("async () => { await window.__inflight; }")
            phone.wait_for_function("() => JSON.parse(localStorage.getItem('diary_sync_queue') || '[]').length === 0", timeout=20000)
            assert any(a['title'] == 'Creada durante la sincronización' for a in api(server, "GET", "/activities")),                 "lo creado mientras viajaba otra sincronización debe llegar al servidor"
            print("  [OK] Un cambio hecho durante una sincronización en curso no se pierde de la cola.")

            pc_browser.close()
            phone_browser.close()
            print("APK y sincronización PC <-> teléfono: verificación PASSED 100%!")
    finally:
        server.stop()


if __name__ == '__main__':
    run()
