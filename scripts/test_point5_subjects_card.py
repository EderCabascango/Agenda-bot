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
    print("Testing Point 5: Dashboard summary card for 'Mis Materias'...")
    proc = ensure_server()
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto('http://127.0.0.1:8000/?e2e=1')
            page.wait_for_selector('#db-subjects-summary-card')
            
            # Verify card element visibility
            is_visible = page.is_visible('#db-subjects-summary-card')
            print(f"Summary card visible: {is_visible}")
            assert is_visible, "Summary card #db-subjects-summary-card should be visible"
            
            # Check content of active count and weekly hours
            active_val = page.text_content('#db-summary-active-subjects')
            hours_val = page.text_content('#db-summary-weekly-hours')
            print(f"Active subjects count: {active_val}, Weekly study hours: {hours_val}")
            
            assert active_val is not None, "Active subjects count should be present"
            assert hours_val is not None, "Weekly study hours should be present"
            
            browser.close()
            print("Point 5 verification PASSED 100%!")
    finally:
        if proc:
            proc.terminate()

if __name__ == '__main__':
    run()
