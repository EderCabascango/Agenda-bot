"""E2E: Fase F y confirmación de acciones críticas.

1. Repaso espaciado: al guardar una nota se crean 4 repasos a 1, 3, 7 y 21 días (y no si se desactiva).
2. Modo no molestar: una alarma que salta durante el enfoque se guarda en silencio y se entrega al terminar.
3. Sonido ambiental: elegir "Lluvia" suena solo mientras el temporizador corre.
4. Temporizador del topbar: sin sesión invita a "Iniciar enfoque".
5. Borrar todo: pide escribir BORRAR, descarga un respaldo y borra también en el servidor.
"""
import json
import urllib.request
from datetime import datetime, timedelta

from playwright.sync_api import sync_playwright
from test_server import TestServerRunner

# Hoy a las 09:58 (hora local): dentro de la vigencia de la sesión de prueba (24 h).
CLOCK_START = datetime.now().replace(hour=9, minute=58, second=0, microsecond=0)
TODAY = CLOCK_START.strftime('%Y-%m-%d')


def api(server, method, path, body=None):
    req = urllib.request.Request(
        f"{server.url}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={**server.auth_headers, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.loads(res.read())


# Cuenta en la página cuántas veces arranca un sonido (AudioBufferSourceNode.start) y si sigue sonando.
AUDIO_SPY = """
(() => {
  window.__ambientStarts = 0; window.__ambientPlaying = 0;
  const P = window.AudioBufferSourceNode && AudioBufferSourceNode.prototype;
  if (!P) return;
  const start = P.start, stop = P.stop;
  P.start = function (...a) { window.__ambientStarts++; window.__ambientPlaying++; return start.apply(this, a); };
  P.stop = function (...a) { window.__ambientPlaying = Math.max(0, window.__ambientPlaying - 1); return stop.apply(this, a); };
})();
"""


def run():
    print("Testing Fase F (repaso espaciado, no molestar, sonido ambiental) y confirmaciones...")
    server = TestServerRunner().start()

    try:
        api(server, "POST", "/sync", {"since": None, "collections": {
            "subjects": [{"id": "sub-ing", "name": "Inglés"}],
            "activities": [
                {"id": "act-alarma", "title": "Llamada importante", "date": TODAY, "startTime": "10:05", "endTime": "10:30"},
                {"id": "act-extra", "title": "Leer", "date": TODAY, "startTime": "18:00", "endTime": "19:00"},
            ],
        }})

        with sync_playwright() as p:
            browser = server.launch_browser(p)
            context = browser.new_context(accept_downloads=True, viewport={'width': 1280, 'height': 900})
            context.add_init_script(AUDIO_SPY)
            context.add_init_script("""localStorage.setItem('diary_settings', JSON.stringify(
                Object.assign(JSON.parse(localStorage.getItem('diary_settings') || '{}'), { notifications: true, alarmAdvance: '0' })));""")
            page = context.new_page()
            page.clock.install(time=CLOCK_START)
            page.goto(f"{server.url}/?e2e=1")
            page.wait_for_load_state("networkidle")
            page.wait_for_function("() => JSON.parse(localStorage.getItem('diary_subjects') || '[]').some(s => s.id === 'sub-ing')")

            # ── 4. Topbar sin sesión ──
            assert page.text_content('#topbar-focus-badge').strip() == 'Iniciar enfoque'
            print("  [OK] Topbar sin sesión: 'Iniciar enfoque'.")

            # ── 1. Repaso espaciado ──
            page.evaluate("() => document.getElementById('btn-add-note').click()")
            page.select_option('#note-subject-select', 'sub-ing')
            page.fill('#note-learned-text', 'Phrasal verbs con get')
            page.click('#btn-save-note')
            page.wait_for_function("""() => JSON.parse(localStorage.getItem('diary_activities') || '[]')
                .filter(a => (a.title || '').startsWith('Repaso ')).length === 4""")
            reviews = page.evaluate("""() => JSON.parse(localStorage.getItem('diary_activities') || '[]')
                .filter(a => (a.title || '').startsWith('Repaso ')).map(a => ({ title: a.title, date: a.date }))
                .sort((x, y) => x.date.localeCompare(y.date))""")
            expected = [(CLOCK_START + timedelta(days=d)).strftime('%Y-%m-%d') for d in (1, 3, 7, 21)]
            assert [r['date'] for r in reviews] == expected, reviews
            assert reviews[0]['title'].startswith('Repaso 1/4: Inglés') and reviews[3]['title'].startswith('Repaso 4/4')
            print(f"  [OK] Nota guardada: repasos el {', '.join(expected)}.")

            page.evaluate("() => { const s = JSON.parse(localStorage.getItem('diary_settings')); s.spacedReview = false; localStorage.setItem('diary_settings', JSON.stringify(s)); }")
            page.evaluate("() => document.getElementById('btn-add-note').click()")
            page.select_option('#note-subject-select', 'sub-ing')
            page.fill('#note-learned-text', 'Otra nota sin repasos')
            page.click('#btn-save-note')
            page.wait_for_timeout(300)
            count = page.evaluate("() => JSON.parse(localStorage.getItem('diary_activities') || '[]').filter(a => (a.title || '').startsWith('Repaso ')).length")
            assert count == 4, f"Con el repaso desactivado no deben crearse más ({count})"
            print("  [OK] Con 'Repaso espaciado' desactivado no se crean repasos.")

            # ── 2 y 3. Enfoque con no molestar y sonido ambiental ──
            page.click('#btn-focus-timer')
            page.wait_for_selector('#focus-timer-overlay.open')
            page.click('#btn-start-focus-session')
            page.wait_for_selector('#focus-active-view', state='visible')
            assert page.is_visible('#focus-dnd-badge'), "Debe verse el aviso 'No molestar'"

            page.select_option('#focus-ambient-select', 'rain')
            page.wait_for_function("() => window.__ambientStarts >= 1 && window.__ambientPlaying === 1")
            assert page.evaluate("() => JSON.parse(localStorage.getItem('diary_settings')).ambientSound") == 'rain'
            print("  [OK] Sonido ambiental 'Lluvia' suena mientras corre el enfoque.")

            page.evaluate("() => { window.__toasts = []; const t = document.getElementById('toast-msg'); new MutationObserver(() => window.__toasts.push(t.textContent)).observe(t, { childList: true, characterData: true, subtree: true }); }")
            page.clock.fast_forward("08:00")  # pasa la alarma de las 10:05
            # Tras el salto, requestAnimationFrame queda congelado: clics con force=True y esperas con polling por intervalo.
            page.wait_for_timeout(300)
            toasts = page.evaluate("() => window.__toasts")
            assert not any('Llamada importante' in t for t in toasts), f"La alarma no debe sonar durante el enfoque: {toasts}"
            print("  [OK] No molestar: la alarma de las 10:05 se guardó en silencio.")

            page.click('#btn-abandon-focus', force=True)
            page.wait_for_selector('#confirm-action-overlay.open')
            page.click('#confirm-action-ok', force=True)
            page.wait_for_function("() => document.getElementById('notif-list').textContent.includes('Llamada importante')", polling=100)
            page.clock.run_for(3000)
            page.wait_for_function("() => document.getElementById('toast-msg').textContent.includes('Mientras te enfocabas')", polling=100)
            assert 'Llamada importante' in page.text_content('#toast-msg')
            page.wait_for_function("() => window.__ambientPlaying === 0", polling=100)
            print("  [OK] Al terminar el enfoque se entrega el aviso pendiente y se apaga el sonido.")

            # ── 5. Borrar todo con BORRAR ──
            page.click('.nav-item[data-view="settings"]', force=True)
            page.click('#btn-clear-data', force=True)
            page.wait_for_selector('#confirm-action-overlay.open')
            assert page.is_disabled('#confirm-action-ok'), "Sin escribir BORRAR el botón debe estar desactivado"
            page.click('#confirm-action-cancel', force=True)
            assert page.evaluate("() => JSON.parse(localStorage.getItem('diary_activities') || '[]').length") > 0

            page.click('#btn-clear-data', force=True)
            page.fill('#confirm-action-typed', 'borrar', force=True)
            assert page.is_disabled('#confirm-action-ok'), "Debe coincidir exactamente con BORRAR"
            page.fill('#confirm-action-typed', 'BORRAR', force=True)
            with page.expect_download() as dl:
                page.click('#confirm-action-ok', force=True)
            assert dl.value.suggested_filename.startswith('mi-diario-respaldo-antes-de-borrar')
            page.wait_for_function("() => JSON.parse(localStorage.getItem('diary_sync_queue') || '[]').length === 0", timeout=15000, polling=100)
            assert page.evaluate("() => JSON.parse(localStorage.getItem('diary_activities') || '[]').length") == 0
            assert api(server, "GET", "/activities") == [], "Las actividades deben borrarse también en el servidor"
            print(f"  [OK] Borrar todo: pide BORRAR, descarga {dl.value.suggested_filename} y borra en el servidor.")

            browser.close()
            print("Fase F y confirmaciones: verificación PASSED 100%!")
    finally:
        server.stop()


if __name__ == '__main__':
    run()
