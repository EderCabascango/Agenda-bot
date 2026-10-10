import os
import sys
import time
import subprocess
import urllib.request
from datetime import datetime, timedelta
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
    print("Testing Point 3: Cycle Heatmap 15->14, 7d/30d bars, legend, accessible tables & viewport screenshots...")
    proc = ensure_server()
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1280, 'height': 900})
            page.goto('http://127.0.0.1:8000/?e2e=1')
            page.wait_for_load_state("networkidle")
            
            # Inject real sessions across the past 30 days and cycle range
            script = """() => {
                const now = new Date();
                const subjects = [
                    { id: 'sub-stats-1', name: 'Inteligencia Artificial', color: '#8B5CF6', deleted_at: null },
                    { id: 'sub-stats-2', name: 'Arquitectura Cloud', color: '#10B981', deleted_at: null }
                ];
                const sessions = [];
                for (let i = 0; i < 30; i++) {
                    const dt = new Date(now);
                    dt.setDate(dt.getDate() - i);
                    const dtStr = dt.toISOString().slice(0, 10);
                    // Add sessions of varying durations (15m, 45m, 90m, 150m)
                    const mins = (i % 4 + 1) * 35;
                    sessions.push({
                        id: 'sess-stats-' + i,
                        subject_id: (i % 2 === 0) ? 'sub-stats-1' : 'sub-stats-2',
                        date: dtStr,
                        started_at: dtStr + 'T10:00:00.000Z',
                        ended_at: dtStr + 'T11:00:00.000Z',
                        effective_seconds: mins * 60,
                        duration_minutes: mins,
                        status: 'completed',
                        created_at: dtStr + 'T10:00:00.000Z'
                    });
                }
                localStorage.setItem('diary_subjects', JSON.stringify(subjects));
                localStorage.setItem('diary_focus_sessions', JSON.stringify(sessions));
                location.reload();
            }"""
            page.evaluate(script)
            page.wait_for_load_state("networkidle")
            time.sleep(0.5)
            
            # Navigate to Estudio -> Estadísticas
            page.click('button[data-view="study"]')
            page.wait_for_selector('#subtab-btn-stats')
            page.click('#subtab-btn-stats')
            page.wait_for_selector('#study-stats-container')
            
            # Verify Cycle Heatmap components
            cycle_grid_count = page.locator('.cycle-heat-grid').count()
            cycle_cells_count = page.locator('.cycle-heat-cell').count()
            legend_count = page.locator('.cycle-heat-legend').count()
            
            print(f"Cycle Heatmap grids: {cycle_grid_count}, Cells: {cycle_cells_count}, Legend: {legend_count}")
            assert cycle_grid_count == 1, "Expected 1 cycle heat grid"
            assert cycle_cells_count >= 28, f"Expected at least 28 cycle cells, found {cycle_cells_count}"
            assert legend_count == 1, "Expected 1 cycle heat legend"
            
            # Verify 7d and 30d bars wraps
            assert page.is_visible('#bars-7d-wrap'), "7d bars wrap should be visible by default"
            assert not page.is_visible('#bars-30d-wrap'), "30d bars wrap should be hidden initially"
            
            # Verify accessible hidden tables (7d, 30d, and Cycle Heatmap)
            tables = page.locator('table.sr-only').all_text_contents()
            print(f"Accessible SR tables found: {len(tables)}")
            assert len(tables) >= 3, f"Expected at least 3 SR tables (7d, 30d, and Cycle Heatmap), found {len(tables)}"
            
            # Take 1280px screenshots (7d and 30d views)
            os.makedirs('screenshots', exist_ok=True)
            page.screenshot(path='screenshots/point3_stats_1280_7d.png', full_page=True)
            page.click('#btn-bars-30d')
            page.screenshot(path='screenshots/point3_stats_1280_30d.png', full_page=True)
            
            # Take 390px screenshots
            page390 = browser.new_page(viewport={'width': 390, 'height': 844})
            page390.goto('http://127.0.0.1:8000/?e2e=1')
            page390.click('button[data-view="study"]')
            page390.wait_for_selector('#subtab-btn-stats')
            page390.click('#subtab-btn-stats')
            page390.wait_for_selector('#study-stats-container')
            page390.screenshot(path='screenshots/point3_stats_390_7d.png', full_page=True)
            page390.click('#btn-bars-30d')
            page390.screenshot(path='screenshots/point3_stats_390_30d.png', full_page=True)
            
            browser.close()
            print("Point 3 verification PASSED 100%!")
    finally:
        if proc:
            proc.terminate()

if __name__ == '__main__':
    run()
