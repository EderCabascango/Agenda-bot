import sys
import time
import subprocess
import urllib.request
from datetime import datetime, timedelta
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
    print("Testing Point 1 & 5: Meta semanal progress calculation (Historical != Current Week)...")
    proc = ensure_server()
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto('http://127.0.0.1:8000/?e2e=1')
            page.wait_for_load_state("networkidle")
            
            # Helper for local date strings
            now = datetime.now()
            # Calculate Monday of current week
            monday = now - timedelta(days=now.weekday())
            mon_str = monday.strftime('%Y-%m-%d')
            old_str = (now - timedelta(days=14)).strftime('%Y-%m-%d')
            
            # Seed 1 subject with weekly goal 5.0h (300 mins) and 2 sessions (1 historical 5h, 1 current week 2h)
            script = f"""() => {{
                const subjects = [
                    {{
                        id: 'sub-meta-test',
                        name: 'Materia Meta Test',
                        color: '#3B82F6',
                        weekly_goal_minutes: 300,
                        created_at: new Date().toISOString()
                    }}
                ];
                const sessions = [
                    {{
                        id: 'sess-old',
                        subject_id: 'sub-meta-test',
                        date: '{old_str}',
                        started_at: '{old_str}T10:00:00.000Z',
                        ended_at: '{old_str}T15:00:00.000Z',
                        effective_seconds: 18000, // 5.0 hours (Historical)
                        duration_minutes: 300,
                        status: 'completed',
                        created_at: '{old_str}T10:00:00.000Z'
                    }},
                    {{
                        id: 'sess-curr',
                        subject_id: 'sub-meta-test',
                        date: '{mon_str}',
                        started_at: '{mon_str}T10:00:00.000Z',
                        ended_at: '{mon_str}T12:00:00.000Z',
                        effective_seconds: 7200, // 2.0 hours (Current week)
                        duration_minutes: 120,
                        status: 'completed',
                        created_at: '{mon_str}T10:00:00.000Z'
                    }}
                ];
                localStorage.setItem('diary_subjects', JSON.stringify(subjects));
                localStorage.setItem('diary_focus_sessions', JSON.stringify(sessions));
                location.reload();
            }}"""
            page.evaluate(script)
            page.wait_for_load_state("networkidle")
            time.sleep(0.5)
            
            # Navigate to Estudio view
            page.click('button[data-view="study"]')
            page.wait_for_selector('.subject-card')
            
            # Check subject card text
            card_text = page.locator('.subject-card', has_text='Materia Meta Test').text_content()
            print(f"Subject card text found:\n'{card_text.strip()}'")
            
            # Assert only current week hours (2h) are displayed in progress card, NOT historical 7h
            assert "2h esta semana / 5.0h" in card_text or "2.0h esta semana" in card_text or "2h esta semana" in card_text, f"Expected '2h esta semana' in card text, got: {card_text}"
            assert "7h esta semana" not in card_text and "7.0h esta semana" not in card_text, "Historical 5h session should NOT count in weekly progress card"
            
            browser.close()
            print("Point 1 & 5 verification PASSED 100%!")
    finally:
        if proc:
            proc.terminate()

if __name__ == '__main__':
    run()
