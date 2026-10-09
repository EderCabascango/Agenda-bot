"""Script de verificación en vivo y generación de capturas de pantalla de la Demo."""
import os
import sys
import time
import urllib.request
import json
from playwright.sync_api import sync_playwright

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCREENSHOTS_DIR = os.path.join(BASE_DIR, "screenshots")
os.makedirs(SCREENSHOTS_DIR, exist_ok=True)

def verify_health():
    print("=== VERIFICANDO ENDPOINTS /health ===")
    for port in [8000, 8001]:
        url = f"http://127.0.0.1:{port}/health"
        req = urllib.request.urlopen(url)
        data = json.loads(req.read().decode('utf-8'))
        print(f"Port {port} ({url}): HTTP {req.status} -> {data}")
        assert req.status == 200

def verify_real_app_and_capture_demo():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # ----------------------------------------------------
        # 1. VERIFICAR APP REAL (PUERTO 8000)
        # ----------------------------------------------------
        print("\n=== VERIFICANDO APP REAL (http://127.0.0.1:8000) ===")
        context_real = browser.new_context()
        page_real = context_real.new_page()

        console_errors_real = []
        page_real.on("console", lambda msg: console_errors_real.append(msg.text) if msg.type == "error" else None)
        page_real.on("pageerror", lambda err: console_errors_real.append(str(err)))

        page_real.goto("http://127.0.0.1:8000/?e2e=1")
        page_real.wait_for_load_state("networkidle")
        time.sleep(1)

        # Sincronizar para asegurar que carga actividades de backend/agenda.db
        page_real.evaluate("async () => { if (window.syncWithBackend) await window.syncWithBackend(); }")
        time.sleep(1)

        real_acts_count = page_real.evaluate("""() => {
            const acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
            return acts.filter(a => !a.deleted_at).length;
        }""")
        print(f"Actividades activas cargadas en navegador (App Real): {real_acts_count}")
        print(f"Errores en consola (App Real): {len(console_errors_real)} {console_errors_real}")
        assert len(console_errors_real) == 0, f"Errores encontrados en App Real: {console_errors_real}"

        # ----------------------------------------------------
        # 2. VERIFICAR Y CAPTURAR APP DEMO (PUERTO 8001)
        # ----------------------------------------------------
        print("\n=== VERIFICANDO Y CAPTURANDO DEMO (http://127.0.0.1:8001) ===")
        context_demo = browser.new_context()
        page_demo = context_demo.new_page()

        console_errors_demo = []
        page_demo.on("console", lambda msg: console_errors_demo.append(msg.text) if msg.type == "error" else None)
        page_demo.on("pageerror", lambda err: console_errors_demo.append(str(err)))

        page_demo.goto("http://127.0.0.1:8001/?e2e=1")
        page_demo.wait_for_load_state("networkidle")
        time.sleep(1)

        # Forzar sincronización desde cero en demo para traer materias y sesiones del backend
        page_demo.evaluate("""async () => {
            localStorage.setItem('diary_last_sync', '0');
            if (window.syncWithBackend) await window.syncWithBackend();
            if (window.renderStudyView) window.renderStudyView();
            if (window.renderDashboard) window.renderDashboard();
        }""")
        time.sleep(1)

        # ----------------------------------------------------
        # A) CAPTURAS ESCRITORIO (1280x800)
        # ----------------------------------------------------
        page_demo.set_viewport_size({"width": 1280, "height": 800})

        # 1. Dashboard Demo
        page_demo.screenshot(path=os.path.join(SCREENSHOTS_DIR, "demo_01_dashboard_desktop.png"), full_page=True)
        print("  -> Captura guardada: screenshots/demo_01_dashboard_desktop.png")

        # 2. Sección Estudio (Materias)
        page_demo.click(".nav-item[data-view='study']")
        page_demo.wait_for_selector("#view-study.active", timeout=3000)
        page_demo.evaluate("() => { if (window.switchStudySubtab) window.switchStudySubtab('subjects'); }")
        time.sleep(0.5)
        page_demo.screenshot(path=os.path.join(SCREENSHOTS_DIR, "demo_02_study_subjects_desktop.png"), full_page=True)
        print("  -> Captura guardada: screenshots/demo_02_study_subjects_desktop.png")

        # 3. Detalle de Materia (Matemáticas)
        page_demo.evaluate("() => { if (window.openSubjectDetailModal) window.openSubjectDetailModal('sub-mat'); }")
        page_demo.wait_for_selector("#modal-subject-detail", state="visible", timeout=3000)
        time.sleep(0.5)
        page_demo.screenshot(path=os.path.join(SCREENSHOTS_DIR, "demo_03_subject_detail_desktop.png"))
        print("  -> Captura guardada: screenshots/demo_03_subject_detail_desktop.png")
        page_demo.click("#btn-close-subject-detail")
        page_demo.wait_for_selector("#subject-detail-overlay", state="hidden", timeout=3000)

        # 4. Estadísticas de Enfoque
        page_demo.evaluate("() => { if (window.switchStudySubtab) window.switchStudySubtab('stats'); }")
        page_demo.wait_for_selector("#study-stats-panel", state="visible", timeout=3000)
        time.sleep(0.5)
        page_demo.screenshot(path=os.path.join(SCREENSHOTS_DIR, "demo_04_study_stats_desktop.png"))
        print("  -> Captura guardada: screenshots/demo_04_study_stats_desktop.png")

        # 5. Temporizador Activo
        page_demo.evaluate("""() => {
            window.openFocusModal({
                method: 'pomodoro',
                subjectId: 'sub-prog',
                goalText: 'Estudio intensivo de Concurrencia con Tokio en Rust'
            });
            window.startFocusSessionFromSetup();
        }""")
        page_demo.wait_for_selector("#focus-active-view", state="visible", timeout=3000)
        time.sleep(0.5)
        page_demo.screenshot(path=os.path.join(SCREENSHOTS_DIR, "demo_05_timer_active_desktop.png"))
        print("  -> Captura guardada: screenshots/demo_05_timer_active_desktop.png")

        # ----------------------------------------------------
        # B) CAPTURAS MÓVIL (390x844)
        # ----------------------------------------------------
        page_demo.set_viewport_size({"width": 390, "height": 844})
        time.sleep(0.5)

        # Mobile Temporizador
        page_demo.screenshot(path=os.path.join(SCREENSHOTS_DIR, "demo_05_timer_active_mobile.png"))
        print("  -> Captura guardada: screenshots/demo_05_timer_active_mobile.png")
        page_demo.click("#focus-timer-close")

        # Mobile Estadísticas
        page_demo.evaluate("() => { if (window.switchStudySubtab) window.switchStudySubtab('stats'); }")
        time.sleep(0.5)
        page_demo.screenshot(path=os.path.join(SCREENSHOTS_DIR, "demo_04_study_stats_mobile.png"))
        print("  -> Captura guardada: screenshots/demo_04_study_stats_mobile.png")

        # Mobile Detalle de Materia
        page_demo.evaluate("() => { if (window.switchStudySubtab) window.switchStudySubtab('subjects'); }")
        time.sleep(0.3)
        page_demo.evaluate("() => { if (window.openSubjectDetailModal) window.openSubjectDetailModal('sub-mat'); }")
        page_demo.wait_for_selector("#modal-subject-detail", state="visible", timeout=3000)
        time.sleep(0.5)
        page_demo.screenshot(path=os.path.join(SCREENSHOTS_DIR, "demo_03_subject_detail_mobile.png"))
        print("  -> Captura guardada: screenshots/demo_03_subject_detail_mobile.png")
        page_demo.click("#btn-close-subject-detail")

        # Mobile Materias
        page_demo.screenshot(path=os.path.join(SCREENSHOTS_DIR, "demo_02_study_subjects_mobile.png"))
        print("  -> Captura guardada: screenshots/demo_02_study_subjects_mobile.png")

        # Mobile Dashboard
        page_demo.click(".bnav-item[data-view='dashboard']")
        time.sleep(0.5)
        page_demo.screenshot(path=os.path.join(SCREENSHOTS_DIR, "demo_01_dashboard_mobile.png"))
        print("  -> Captura guardada: screenshots/demo_01_dashboard_mobile.png")

        browser.close()

if __name__ == "__main__":
    verify_health()
    verify_real_app_and_capture_demo()
