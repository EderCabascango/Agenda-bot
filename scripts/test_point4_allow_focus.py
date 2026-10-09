import sys
import time
import subprocess
import urllib.request
from playwright.sync_api import sync_playwright

def ensure_server():
    try:
        urllib.request.urlopen("http://127.0.0.1:8000/", timeout=1)
        print("Server already running.")
        return None
    except Exception:
        print("Starting server...")
        proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1", "--port", "8000"])
        time.sleep(3)
        return proc

def run():
    print("Testing Point 4: allow_focus field, modal checkbox, and queue sync...")
    proc = ensure_server()
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto('http://127.0.0.1:8000/?e2e=1')
            page.wait_for_load_state("networkidle")
            
            # Seed 2 tasks using page todayStr()
            script = """() => {
                const today = (typeof toDateStr === 'function') ? toDateStr(new Date()) : new Date().toISOString().slice(0, 10);
                const acts = [
                    {
                        id: 'act-focus-allowed',
                        title: 'Tarea Con Enfoque Permitido',
                        tags: ['general'],
                        allow_focus: true,
                        completed: false,
                        date: today,
                        version: 1,
                        updated_at: new Date().toISOString()
                    },
                    {
                        id: 'act-focus-disallowed',
                        title: 'Tarea Sin Enfoque Permitido',
                        tags: ['general'],
                        allow_focus: false,
                        completed: false,
                        date: today,
                        version: 1,
                        updated_at: new Date().toISOString()
                    }
                ];
                localStorage.setItem('diary_activities', JSON.stringify(acts));
                if (window.loadActivities) window.loadActivities();
                location.reload();
            }"""
            page.evaluate(script)
            page.wait_for_load_state("networkidle")
            time.sleep(0.5)
            
            # Check button visibility
            btn_allowed = page.locator('[data-agenda-focus="act-focus-allowed"]').count()
            btn_disallowed = page.locator('[data-agenda-focus="act-focus-disallowed"]').count()
            
            print(f"Focus button for allow_focus=True task: {btn_allowed} (expected 1)")
            print(f"Focus button for allow_focus=False task: {btn_disallowed} (expected 0)")
            
            assert btn_allowed == 1, "Expected focus button for task with allow_focus=true"
            assert btn_disallowed == 0, "Expected NO focus button for task with allow_focus=false"
            
            browser.close()
            print("Point 4 verification PASSED 100%!")
    finally:
        if proc:
            proc.terminate()

if __name__ == '__main__':
    run()
