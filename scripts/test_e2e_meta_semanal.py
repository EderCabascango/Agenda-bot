import time
from datetime import datetime, timedelta
from playwright.sync_api import sync_playwright
from test_server import TestServerRunner

def run():
    print("Testing Point 1 & 5: Meta semanal progress calculation (Historical != Current Week)...")
    server = TestServerRunner().start()
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(f"{server.url}/?e2e=1")
            page.wait_for_load_state("networkidle")
            
            # Helper for local date strings
            # Seed 1 subject with weekly goal 5.0h (300 mins) and 2 sessions (1 historical 5h, 1 current week 2h)
            script = """() => {
                const now = new Date();
                const currStr = (typeof toDateStr === 'function') ? toDateStr(now) : now.toISOString().slice(0, 10);
                const oldDt = new Date(now);
                oldDt.setDate(oldDt.getDate() - 14);
                const oldStr = (typeof toDateStr === 'function') ? toDateStr(oldDt) : oldDt.toISOString().slice(0, 10);

                const subjects = [
                    {
                        id: 'sub-meta-test',
                        name: 'Materia Meta Test',
                        color: '#3B82F6',
                        weekly_goal_minutes: 300,
                        created_at: now.toISOString()
                    }
                ];
                const sessions = [
                    {
                        id: 'sess-old',
                        subject_id: 'sub-meta-test',
                        date: oldStr,
                        started_at: oldStr + 'T10:00:00.000Z',
                        ended_at: oldStr + 'T15:00:00.000Z',
                        effective_seconds: 18000, // 5.0 hours (Historical)
                        duration_minutes: 300,
                        status: 'completed',
                        created_at: oldStr + 'T10:00:00.000Z'
                    },
                    {
                        id: 'sess-curr',
                        subject_id: 'sub-meta-test',
                        date: currStr,
                        started_at: currStr + 'T10:00:00.000Z',
                        ended_at: currStr + 'T12:00:00.000Z',
                        effective_seconds: 7200, // 2.0 hours (Current week)
                        duration_minutes: 120,
                        status: 'completed',
                        created_at: currStr + 'T10:00:00.000Z'
                    }
                ];
                localStorage.setItem('diary_subjects', JSON.stringify(subjects));
                localStorage.setItem('diary_focus_sessions', JSON.stringify(sessions));
                location.reload();
            }"""
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
        server.stop()

if __name__ == '__main__':
    run()
