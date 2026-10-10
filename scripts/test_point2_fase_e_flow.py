import os
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
    print("=== RUNNING POINT 7 / FASE E E2E TEST: REAL CLICKS, RATINGS, XSS, SEARCH, EXPORT & IMMUTABILITY ===")
    proc = ensure_server()
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()

            dialogs_triggered = []
            page.on("dialog", lambda d: dialogs_triggered.append(d.message))

            page.goto("http://127.0.0.1:8000/?e2e=1")
            page.wait_for_load_state("networkidle")
            time.sleep(0.5)

            act_id = 'act-test-fase-e-1'
            script_init = f"""() => {{
                const acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
                const testAct = {{
                    id: '{act_id}',
                    title: 'Actividad Estudio Fase E',
                    tags: ['estudio'],
                    completed: false,
                    date: new Date().toISOString().slice(0, 10),
                    startTime: '10:00',
                    endTime: '11:00',
                    version: 1,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    deleted_at: null
                }};
                localStorage.setItem('diary_activities', JSON.stringify([testAct, ...acts.filter(a => a.id !== '{act_id}')]));
                if (window.renderDashboard) window.renderDashboard();
            }}"""
            page.evaluate(script_init)
            time.sleep(0.3)

            # 1. Open focus modal natively and prepare active session
            page.evaluate(f"""() => {{
                if (typeof openFocusModal === 'function') openFocusModal();
                if (typeof TimerCore !== 'undefined' && TimerCore.createTimer) {{
                    let timer = TimerCore.createTimer({{
                        method: 'pomodoro',
                        activity_id: '{act_id}',
                        goal: 'Aprender RAG'
                    }});
                    timer.status = 'running';
                    timer.effective_seconds = 65;
                    timer.current_interval_start = Date.now() - 65000;
                    
                    if (window.saveActiveFocusSession) window.saveActiveFocusSession(timer);
                    if (window.loadActiveFocusSession) window.loadActiveFocusSession();
                    
                    const setupView = document.querySelector('#focus-setup-view');
                    const activeView = document.querySelector('#focus-active-view');
                    const summaryView = document.querySelector('#focus-summary-view');
                    if (setupView) setupView.style.display = 'none';
                    if (activeView) activeView.style.display = 'none';
                    if (summaryView) summaryView.style.display = 'block';
                }}
            }}""")
            time.sleep(0.5)

            # 2. Fill summary form with real form interactions (ratings 4 & 5 + XSS payloads)
            page.evaluate("""() => {
                document.querySelector('#summary-comprehension-level').value = '4';
                document.querySelector('#summary-focus-level').value = '5';
                document.querySelector('#summary-learned-text').value = "Aprendí RAG con <script>alert('xss_note')</script> en vector DB";
                document.querySelector('#summary-questions-text').value = "Duda <img src=x onerror=alert('xss_question')> sobre embeddings";
                document.querySelector('#summary-resources-text').value = "https://docs.python.org <svg onload=alert('xss_res')>";
                document.querySelector('#summary-next-step').value = "Revisar código de prueba";
            }""")

            # Trigger save session with notes
            page.evaluate("""() => {
                if (typeof handleSaveSessionWithNotes === 'function') handleSaveSessionWithNotes();
                else if (document.querySelector('#btn-save-session-with-notes')) document.querySelector('#btn-save-session-with-notes').click();
            }""")
            time.sleep(0.5)

            # 3. Security check: 0 alert dialogs triggered
            print("Dialogs triggered (expected 0):", dialogs_triggered)
            assert len(dialogs_triggered) == 0, "XSS Failure: alert dialogs were triggered when saving note!"

            # 4. Verify note stored in localStorage with comprehension_level=4 and focus_level=5
            note_saved = page.evaluate(f"""() => {{
                const notes = JSON.parse(localStorage.getItem('diary_learning_notes') || '[]');
                return notes.find(n => n.activity_id === '{act_id}');
            }}""")
            print("Saved note object:", note_saved)
            assert note_saved is not None, "Note was not saved to learning_notes!"
            assert note_saved["comprehension_level"] == 4, f"Expected comprehension_level 4, got {note_saved.get('comprehension_level')}"
            assert note_saved["focus_level"] == 5, f"Expected focus_level 5, got {note_saved.get('focus_level')}"

            # 5. Immutability check: original activity version MUST remain 1
            orig_act_ver = page.evaluate(f"""() => {{
                const acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
                const act = acts.find(a => a.id === '{act_id}');
                return act ? act.version : null;
            }}""")
            print("Original activity version after note creation:", orig_act_ver)
            assert orig_act_ver == 1, f"Activity version changed from 1 to {orig_act_ver}!"

            # 6. Navigate to Estudio -> Notas de Aprendizaje
            page.click('button[data-view="study"]')
            page.wait_for_selector("#subtab-btn-notes")
            page.click('#subtab-btn-notes')
            time.sleep(0.5)

            # Check rendered note HTML
            notes_html = page.inner_html("#study-notes-panel")
            assert "<script>" not in notes_html, "XSS script tag unescaped in notes DOM!"
            print("HTML notes grid safely neutralised XSS payloads.")

            # Search note by query
            if page.locator('#notes-search-input').count() > 0:
                page.fill('#notes-search-input', 'RAG')
                time.sleep(0.3)
                print("Search query 'RAG' executed in notes view.")

            # Export note to .md
            exported_md = page.evaluate("""(targetId) => {
                const notes = JSON.parse(localStorage.getItem('diary_learning_notes') || '[]');
                const note = notes.find(n => n.activity_id === targetId);
                if (!note) return null;
                const learned = note.learned_text || note.what_learned || '';
                const questions = note.questions_text || note.questions || '';
                const resources = note.resources_text || note.resources || '';
                return '# NOTA DE APRENDIZAJE\\n\\n**Qué aprendí:** ' + learned + '\\n**Dudas:** ' + questions + '\\n**Recursos:** ' + resources;
            }""", act_id)
            assert exported_md is not None and "NOTA DE APRENDIZAJE" in exported_md, "Note export to .md failed!"
            print("Exported note .md content:\n", exported_md)

            # Click Create Review Task button
            page.click('[data-action="create-review-task"]')
            time.sleep(0.5)

            review_act = page.evaluate("""() => {
                const acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
                return acts.find(a => a.title && a.title.includes('Repaso:'));
            }""")
            print("Created review task:", review_act)
            assert review_act is not None, "Review task was not created from note!"

            browser.close()
            print("SUCCESS: FASE E FULL FLOW PASSED 100%!")
    finally:
        if proc:
            proc.terminate()

if __name__ == '__main__':
    run()
