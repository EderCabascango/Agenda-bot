import os
import sys
import time
import subprocess
import urllib.request
from playwright.sync_api import sync_playwright

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BACKEND_DIR = os.path.join(ROOT_DIR, "backend")

def ensure_server():
    try:
        urllib.request.urlopen("http://127.0.0.1:8000/", timeout=1)
        print("Server already running.")
        return None
    except Exception:
        print("Starting server...")
        env = os.environ.copy()
        env["PYTHONPATH"] = BACKEND_DIR
        proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "8000"], cwd=BACKEND_DIR, env=env)
        time.sleep(3)
        return proc

def run():
    print("Generating Agenda de Hoy screenshots at 1280px and 390px viewports...")
    proc = ensure_server()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            
            # 1280px Desktop
            page1280 = browser.new_page(viewport={"width": 1280, "height": 800})
            page1280.goto('http://127.0.0.1:8000/?e2e=1')
            page1280.wait_for_load_state("networkidle")
            
            script_seed = """() => {
                const today = (typeof toDateStr === 'function') ? toDateStr(new Date()) : new Date().toISOString().slice(0, 10);
                const settings = { defaultFocusTags: ['estudio', 'proyectos', 'ia', 'idiomas', 'lectura', 'programación', 'programacion', 'study', 'projects'] };
                localStorage.setItem('agenda_settings', JSON.stringify(settings));

                const acts = [
                    {
                        id: 'act-dormir',
                        title: 'Dormir ocho horas',
                        tags: ['salud'],
                        allow_focus: false,
                        completed: false,
                        date: today,
                        time: '07:00 - 08:00',
                        version: 1,
                        updated_at: new Date().toISOString()
                    },
                    {
                        id: 'act-ingles',
                        title: 'Estudiar Gramática de Inglés',
                        tags: ['idiomas'],
                        allow_focus: true,
                        completed: false,
                        date: today,
                        time: '09:00 - 10:00',
                        version: 1,
                        updated_at: new Date().toISOString()
                    }
                ];
                localStorage.setItem('diary_activities', JSON.stringify(acts));
                if (window.activities) {
                    window.activities.length = 0;
                    window.activities.push(...acts);
                }
                if (window.renderDashboard) window.renderDashboard();
                if (window.renderActivityList) window.renderActivityList();
            }"""
            page1280.evaluate(script_seed)
            page1280.reload()
            page1280.wait_for_load_state("networkidle")
            time.sleep(0.5)
            page1280.screenshot(path="screenshots/agenda_today_1280.png")
            print("Captured screenshots/agenda_today_1280.png")

            # 390px Mobile
            page390 = browser.new_page(viewport={"width": 390, "height": 844})
            page390.goto('http://127.0.0.1:8000/?e2e=1')
            page390.wait_for_load_state("networkidle")
            page390.evaluate(script_seed)
            page390.reload()
            page390.wait_for_load_state("networkidle")
            time.sleep(0.5)
            page390.screenshot(path="screenshots/agenda_today_390.png")
            print("Captured screenshots/agenda_today_390.png")

            browser.close()
    finally:
        if proc:
            proc.terminate()

if __name__ == '__main__':
    run()
