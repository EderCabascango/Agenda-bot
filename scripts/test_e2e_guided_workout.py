"""E2E: plan semanal y entreno guiado con descansos cronometrados (reloj falso).

1. "Cargar plan sugerido" crea 5 rutinas con días; la tarjeta "Hoy toca" muestra la rutina del día.
2. Empezar guiado: serie de reps con selector -> "Hecho" con 13 reps -> descanso cronometrado.
3. El descanso de 60 s corre; +15 s suma tiempo; al llegar a 0 avisa y ESPERA (no avanza solo) hasta "Siguiente".
4. Un isométrico tiene cuenta atrás; "Saltar descanso" funciona; el entreno se puede pausar sin que corra el reloj.
5. Guardar desde el guiado solo registra las series hechas, con su duración, y llega al servidor.
6. Cambiar el día por "Correr suave": cardio con cronómetro y km.
"""
import json
import urllib.request
from datetime import datetime

from playwright.sync_api import sync_playwright
from test_server import TestServerRunner


def server_collection(server, name):
    req = urllib.request.Request(
        f"{server.url}/sync", method="POST",
        data=json.dumps({"since": None, "full_pull": True, "collections": {name: []}}).encode(),
        headers={**server.auth_headers, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as res:
        return [x for x in json.loads(res.read())["results"][name]["changes"] if not x["deleted_at"]]


def clock_secs(page, selector='#guided-clock'):
    m, sec = page.text_content(selector).strip().split(':')[-2:]
    return int(m) * 60 + int(sec)


def approx(value, expected, tol=2):
    assert abs(value - expected) <= tol, f"{value} s no está cerca de {expected} s"


def run():
    print("Testing plan semanal y entreno guiado...")
    server = TestServerRunner().start()
    try:
        with sync_playwright() as p:
            browser = server.launch_browser(p)
            context = browser.new_context(viewport={'width': 1280, 'height': 900})
            context.add_init_script("""(() => {
              window.__sounds = [];
              const Real = window.AudioContext || window.webkitAudioContext;
              if (!Real) return;
              const P = OscillatorNode.prototype, start = P.start;
              P.start = function (...a) { window.__sounds.push(this.frequency.value); return start.apply(this, a); };
              navigator.vibrate = (pattern) => { (window.__vibrations = window.__vibrations || []).push(pattern); return true; };
            })();""")
            page = context.new_page()
            page.clock.install(time=datetime.now())
            page.goto(f"{server.url}/?e2e=1")
            page.wait_for_load_state("networkidle")

            # ── 1. Plan sugerido y "Hoy toca" ──
            page.click('.nav-item[data-view="workout"]')
            page.click('[data-workout-tab="routines"]')
            page.click('#btn-load-plan')
            page.wait_for_function("() => JSON.parse(localStorage.getItem('diary_sync_queue') || '[]').length === 0", timeout=15000, polling=100)
            routines = {r['id']: r for r in server_collection(server, 'workout_routines')}
            assert set(routines) == {'plan-a', 'plan-b', 'plan-c', 'plan-caminar', 'plan-correr'}
            assert routines['plan-a']['days'] == [0] and routines['plan-correr']['days'] == [3]
            flex = [e for e in routines['plan-a']['exercises'] if e['name'] == 'Flexiones'][0]
            assert (flex['target_reps_min'], flex['target_reps_max'], flex['rest_seconds']) == (8, 12, 60)
            assert page.is_hidden('#btn-load-plan'), "con el plan completo el botón se oculta"

            # Para probar el guiado sobre A · Full body, se asigna también a hoy desde el editor.
            weekday = datetime.now().weekday()
            page.click('#workout-routines-list .workout-routine-card:has-text("A · Full body") [data-edit-routine]')
            if weekday != 0:
                page.click(f'#routine-editor-days [data-day="{weekday}"]')
            page.click('#routine-editor-save')
            page.click('[data-workout-tab="train"]')
            today_card = page.text_content('#workout-today')
            assert 'A · Full body' in today_card, today_card
            assert 'Correr suave' in today_card or weekday == 3, "ofrece cambiar el día por cardio"
            print("  [OK] Plan sugerido (5 rutinas con días) y tarjeta 'Hoy toca'.")

            # ── 2. Empezar guiado y primera serie de reps ──
            page.click('#workout-today [data-start-routine="plan-a"]')
            page.wait_for_selector('#workout-overlay.open')
            assert page.locator('[data-workout-mode="guided"].active').count() == 1, "las rutinas abren en modo guiado"
            page.click('[data-guided="start"]')
            assert 'Calentamiento' in page.text_content('.guided-exercise')
            page.click('[data-guided="done"]')                       # calentamiento -> descanso 30 s
            assert 'Descanso' in page.text_content('.guided-kicker')
            page.click('[data-guided="next"]')                       # saltar descanso
            assert 'Sentadillas' in page.text_content('.guided-exercise')
            assert '12–15 reps' in page.text_content('.guided-target')
            assert page.input_value('#guided-reps') == '15'
            page.click('[data-guided="reps-1"]')
            page.click('[data-guided="reps-1"]')
            page.fill('#guided-weight', '2.5')
            page.click('[data-guided="done"]')
            print("  [OK] Serie de sentadillas registrada con el selector (13 reps, +2.5 kg).")

            # ── 3. Descanso cronometrado que avisa y espera ──
            assert page.text_content('.guided-kicker').strip() == 'Descanso'
            approx(clock_secs(page), 60)
            assert 'Sentadillas' in page.text_content('.guided-next') and 'serie 2/3' in page.text_content('.guided-next')
            page.clock.run_for(20_000)
            approx(clock_secs(page), 40)
            page.click('[data-guided="add15"]')
            page.clock.run_for(1_000)
            approx(clock_secs(page), 54)
            page.clock.run_for(60_000)
            page.wait_for_function("() => document.querySelector('.guided-kicker').textContent.includes('terminado')", polling=100)
            assert clock_secs(page) == 0
            sounds = page.evaluate("() => window.__sounds")
            assert 660 in sounds and 1175 in sounds, f"aviso a 3 s y pitido final: {sounds}"
            assert page.evaluate("() => (window.__vibrations || []).length") >= 1, "vibra al terminar"
            page.clock.run_for(30_000)
            assert 'terminado' in page.text_content('.guided-kicker'), "espera a 'Siguiente' sin avanzar solo"
            page.click('[data-guided="next"]')
            assert 'Serie 2 de 3' in page.text_content('.guided-kicker')
            print("  [OK] Descanso de 60 s con +15 s: al terminar pita, vibra y espera a 'Siguiente'.")

            # ── 4. Pausa e isométrico ──
            page.click('[data-guided="pause"]')
            total_before = page.text_content('#guided-total')
            page.clock.run_for(120_000)
            assert page.text_content('#guided-total') == total_before, "en pausa no corre el cronómetro total"
            page.click('[data-guided="resume"]')
            # Avanza hasta la plancha haciendo series rápidas y saltando descansos
            for _ in range(60):
                if page.locator('.guided-exercise:has-text("Plancha")').count():
                    break
                if page.locator('[data-guided="next"]').count():
                    page.click('[data-guided="next"]')
                else:
                    page.click('[data-guided="done"]')
            assert page.text_content('.guided-target').strip().endswith('30 s')
            approx(clock_secs(page), 30)
            page.clock.run_for(10_000)
            approx(clock_secs(page), 20)
            page.click('[data-guided="done"]')
            print("  [OK] Pausa sin contar tiempo e isométrico con cuenta atrás (30 s).")

            # ── 5. Guardar solo lo hecho ──
            page.click('#workout-save')
            page.wait_for_function("() => JSON.parse(localStorage.getItem('diary_sync_queue') || '[]').length === 0", timeout=15000, polling=100)
            saved = server_collection(server, 'workouts')
            assert len(saved) == 1
            w = saved[0]
            exs = {e['name']: e for e in w['exercises']}
            assert exs['Sentadillas']['sets'][0] == {'reps': 13, 'seconds': 0, 'weight_kg': 2.5, 'distance_km': 0.0}
            approx(exs['Plancha']['sets'][0]['seconds'], 10)  # isométrico terminado antes: guarda lo aguantado
            assert len(exs['Plancha']['sets']) == 1, "solo las series hechas"
            assert 'Estiramientos' not in exs, "lo no hecho no se guarda"
            assert 2 <= w['duration_minutes'] <= 3, f"~2 min de entreno (la pausa de 2 min no cuenta): {w['duration_minutes']}"
            print(f"  [OK] Guardado solo lo hecho ({len(w['exercises'])} ejercicios, {w['duration_minutes']} min).")

            # ── 6. Cambiar el día por correr ──
            if weekday != 3:
                page.click('#workout-today [data-start-routine="plan-correr"]')
            else:
                page.click('#workout-start-list [data-start-routine="plan-correr"]')
            page.wait_for_selector('#workout-overlay.open')
            page.click('[data-guided="start"]')
            assert 'Cardio' in page.text_content('.guided-kicker')
            page.clock.run_for(5 * 60_000)
            approx(clock_secs(page), 300)  # cronómetro de cardio hacia arriba
            page.fill('#guided-km', '0.85')
            page.click('[data-guided="done"]')
            page.click('[data-guided="save"]')
            page.wait_for_function("() => JSON.parse(localStorage.getItem('diary_sync_queue') || '[]').length === 0", timeout=15000, polling=100)
            run_w = [x for x in server_collection(server, 'workouts') if x['routine_id'] == 'plan-correr'][0]
            assert run_w['exercises'][0]['measure'] == 'cardio'
            approx(run_w['exercises'][0]['sets'][0]['seconds'], 300)
            assert run_w['exercises'][0]['sets'][0]['distance_km'] == 0.85
            assert '0.85 km' in page.text_content('#workout-week-summary')
            print("  [OK] Cambiar el día por correr: cardio de 5 min y 0.85 km guardado y en el resumen.")

            # ── 7. "Crear rutina" en Entrenar y descanso editable en el entreno libre ──
            page.click('#btn-train-new-routine')
            page.wait_for_selector('#routine-editor-overlay.open')
            assert page.text_content('#routine-editor-title') == 'Nueva rutina'
            page.click('#routine-editor-cancel')
            page.click('#btn-workout-free')
            page.wait_for_selector('#workout-overlay.open')
            page.click('[data-workout-mode="table"]')
            page.fill('#workout-exercises .workout-ex-name', 'Flexiones')
            page.click('[data-add-set="0"]')
            page.fill('#workout-exercises [data-field="rest_seconds"]', '90')
            page.click('[data-workout-mode="guided"]')
            assert '90s desc.' in page.text_content('#workout-guided')
            draft = page.evaluate("() => JSON.parse(localStorage.getItem('diary_workout_draft'))")
            assert draft['exercises'][0]['rest_seconds'] == 90
            print("  [OK] Botón 'Crear rutina' en Entrenar y descanso entre series editable en el entreno libre (90 s).")

            browser.close()
            print("Plan semanal y entreno guiado: verificación PASSED 100%!")
    finally:
        server.stop()


if __name__ == '__main__':
    run()
