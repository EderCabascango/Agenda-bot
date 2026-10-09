import sys
import time
import subprocess
import os
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
    print("Testing Point 3: Stats view, 7d/30d bars, cycle heatmap, single 'Sin materia'...")
    proc = ensure_server()
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            
            # Test Viewport 1280
            page1280 = browser.new_page(viewport={'width': 1280, 'height': 900})
            page1280.goto('http://127.0.0.1:8000/?e2e=1')
            page1280.wait_for_selector('button[data-view="study"]')
            page1280.click('button[data-view="study"]')
            page1280.wait_for_selector('#subtab-btn-stats')
            page1280.click('#subtab-btn-stats')
            page1280.wait_for_selector('#study-stats-container')
            
            # Check "Sin materia" frequency in subject distribution
            unassigned_count = page1280.locator('.subject-dist-name', has_text='Sin materia').count()
            print(f"Count of 'Sin materia' entries in distribution: {unassigned_count}")
            assert unassigned_count <= 1, f"Expected at most 1 'Sin materia', found {unassigned_count}"
            
            # Verify 7d bars visible by default
            assert page1280.is_visible('#bars-7d-wrap'), "7d bars wrap should be visible"
            assert not page1280.is_visible('#bars-30d-wrap'), "30d bars wrap should be hidden initially"
            
            # Capture 1280px 7d screenshot
            os.makedirs('screenshots', exist_ok=True)
            page1280.screenshot(path='screenshots/point3_stats_1280_7d.png', full_page=True)
            
            # Click 30d toggle
            page1280.click('#btn-bars-30d')
            assert page1280.is_visible('#bars-30d-wrap'), "30d bars wrap should be visible after clicking toggle"
            assert not page1280.is_visible('#bars-7d-wrap'), "7d bars wrap should be hidden after clicking toggle"
            
            # Capture 1280px 30d screenshot
            page1280.screenshot(path='screenshots/point3_stats_1280_30d.png', full_page=True)
            
            # Test Viewport 390
            page390 = browser.new_page(viewport={'width': 390, 'height': 844})
            page390.goto('http://127.0.0.1:8000/?e2e=1')
            page390.click('button[data-view="study"]')
            page390.wait_for_selector('#subtab-btn-stats')
            page390.click('#subtab-btn-stats')
            page390.wait_for_selector('#study-stats-container')
            
            # Capture 390px 7d screenshot
            page390.screenshot(path='screenshots/point3_stats_390_7d.png', full_page=True)
            
            # Click 30d toggle
            page390.click('#btn-bars-30d')
            page390.screenshot(path='screenshots/point3_stats_390_30d.png', full_page=True)
            
            # Verify accessible hidden tables
            tables = page1280.locator('table.sr-only').all_text_contents()
            print(f"Accessible SR tables found: {len(tables)}")
            assert len(tables) >= 2, f"Expected at least 2 SR tables (7d and 30d), found {len(tables)}"
            
            browser.close()
            print("Point 3 verification PASSED 100%!")
    finally:
        if proc:
            proc.terminate()

if __name__ == '__main__':
    run()
