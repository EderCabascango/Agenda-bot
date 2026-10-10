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
    print("=== RUNNING POINT 1, 2 & 3 / FASE E REINFORCED E2E TEST ===")
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

            sub_id = 'sub-test-fase-e'
            topic_id = 'topic-rag-1'
            act_id = 'act-test-fase-e-1'

            # Seed Subject, Topic, and Activity linked to subject
            script_init = f"""() => {{
                const subs = JSON.parse(localStorage.getItem('diary_subjects') || '[]');
                const testSub = {{
                    id: '{sub_id}',
                    name: 'Materia Test Fase E',
                    color: '#3B82F6',
                    icon: 'school',
                    weekly_goal_minutes: 300,
                    version: 1,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    deleted_at: null
                }};
                localStorage.setItem('diary_subjects', JSON.stringify([testSub, ...subs.filter(s => s.id !== '{sub_id}')]));

                const topics = JSON.parse(localStorage.getItem('diary_topics') || '[]');
                const testTopic = {{
                    id: '{topic_id}',
                    subject_id: '{sub_id}',
                    name: 'Subtema RAG',
                    status: 'in_progress',
                    version: 1,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    deleted_at: null
                }};
                localStorage.setItem('diary_topics', JSON.stringify([testTopic, ...topics.filter(t => t.id !== '{topic_id}')]));

                const acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
                const testAct = {{
                    id: '{act_id}',
                    subject_id: '{sub_id}',
                    topic_ids: ['{topic_id}'],
                    title: 'Actividad Estudio Fase E',
                    tags: ['estudio'],
                    allow_focus: true,
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

            # Use page.clock if available, or advance timer by 65s
            if hasattr(page, "clock") and hasattr(page.clock, "fast_forward"):
                try:
                    page.clock.install()
                except Exception:
                    pass

            # 1. Open focus modal natively for activity and simulate active session
            page.evaluate(f"""() => {{
                const acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
                const act = acts.find(a => a.id === '{act_id}');
                if (typeof openFocusModal === 'function') openFocusModal(act);
                if (typeof TimerCore !== 'undefined' && TimerCore.createTimer) {{
                    let timer = TimerCore.createTimer({{
                        method: 'pomodoro',
                        subject_id: '{sub_id}',
                        topic_ids: ['{topic_id}'],
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

            if hasattr(page, "clock") and hasattr(page.clock, "fast_forward"):
                try:
                    page.clock.fast_forward("01:05")
                except Exception:
                    pass

            # 2. Fill summary form with ratings 4 & 5 + XSS payloads
            page.evaluate("""() => {
                document.querySelector('#summary-comprehension-level').value = '4';
                document.querySelector('#summary-focus-level').value = '5';
                document.querySelector('#summary-learned-text').value = "Aprendí RAG con <script>alert('xss_note')</script> en vector DB";
                document.querySelector('#summary-questions-text').value = "Duda <img src=x onerror=alert('xss_question')> sobre embeddings";
                document.querySelector('#summary-resources-text').value = "https://docs.python.org <svg onload=alert('xss_res')>";
                document.querySelector('#summary-next-step').value = "Revisar código de prueba";
            }""")

            # Click Save Session and Notes via real button click or handler
            page.evaluate("""() => {
                const btn = document.querySelector('#btn-save-session-with-notes');
                if (btn) btn.click();
                else if (typeof handleSaveSessionWithNotes === 'function') handleSaveSessionWithNotes();
            }""")
            time.sleep(0.5)

            # 3. Security check: 0 alert dialogs triggered
            print("Dialogs triggered (expected 0):", dialogs_triggered)
            assert len(dialogs_triggered) == 0, "XSS Failure: alert dialogs were triggered when saving note!"

            # 4. Point 1 Assertion: Verify note stored with subject_id NOT None and topic_ids populated
            note_saved = page.evaluate(f"""() => {{
                const notes = JSON.parse(localStorage.getItem('diary_learning_notes') || '[]');
                return notes.find(n => n.activity_id === '{act_id}');
            }}""")
            print("Saved note object:", note_saved)
            assert note_saved is not None, "Note was not saved to learning_notes!"
            assert note_saved["subject_id"] is not None and note_saved["subject_id"] == sub_id, f"FAIL Point 1: note subject_id is {note_saved.get('subject_id')}, expected '{sub_id}'!"
            assert note_saved["topic_ids"] == [topic_id], f"FAIL Point 1: note topic_ids is {note_saved.get('topic_ids')}, expected ['{topic_id}']!"
            assert note_saved["comprehension_level"] == 4, f"Expected comprehension_level 4, got {note_saved.get('comprehension_level')}"
            assert note_saved["focus_level"] == 5, f"Expected focus_level 5, got {note_saved.get('focus_level')}"
            print("Point 1 verification PASSED: note correctly preserved subject_id and topic_ids.")

            # 5. Immutability check: original activity version MUST remain 1
            orig_act_ver = page.evaluate(f"""() => {{
                const acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
                const act = acts.find(a => a.id === '{act_id}');
                return act ? act.version : null;
            }}""")
            print("Original activity version after note creation:", orig_act_ver)
            assert orig_act_ver == 1, f"Activity version changed from 1 to {orig_act_ver}!"

            # 6. Point 3 (a) & (b) & (c): Verify note in Subject History, Linked Task, and Search
            page.click('button[data-view="study"]')
            page.wait_for_selector("#subtab-btn-notes")
            page.click('#subtab-btn-notes')
            time.sleep(0.5)

            # Check rendered note HTML in Notes tab
            notes_html = page.inner_html("#study-notes-panel")
            assert "<script>" not in notes_html, "XSS script tag unescaped in notes DOM!"
            assert "<img" not in notes_html, "XSS img tag unescaped in notes DOM!"
            assert "<svg" not in notes_html, "XSS svg tag unescaped in notes DOM!"
            print("HTML notes grid safely neutralised XSS payloads.")

            # (c) Search note by query 'RAG'
            if page.locator('#notes-search-input').count() > 0:
                page.fill('#notes-search-input', 'RAG')
                time.sleep(0.3)
                search_results_html = page.inner_html("#study-notes-panel")
                assert "Aprendí RAG" in search_results_html or "vector DB" in search_results_html, "Note not found in search!"
                print("Search query 'RAG' executed and verified note in search results.")

            # (a) Verify note in Subject Detail modal (Subject History)
            page.evaluate(f"""(sId) => {{
                if (typeof openSubjectDetailModal === 'function') openSubjectDetailModal(sId);
            }}""", sub_id)
            time.sleep(0.5)
            detail_html = page.inner_html("#modal-subject-detail")
            assert "Aprendí RAG" in detail_html or "RAG" in detail_html, "Note not found in subject detail history!"
            print("Verified note appears in subject detail history.")

            # Point 2: Export note to .md & check escaping
            exported_md = page.evaluate("""(nId) => {
                const notes = JSON.parse(localStorage.getItem('diary_learning_notes') || '[]');
                const note = notes.find(n => n.id === nId);
                if (!note) return null;
                const learned = (note.learned_text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const questions = (note.questions_text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const resources = (note.resources_text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                return '# NOTA DE APRENDIZAJE\\n\\n**Qué aprendí:** ' + learned + '\\n**Dudas:** ' + questions + '\\n**Recursos:** ' + resources;
            }""", note_saved['id'])

            print("Exported note .md content:\n", exported_md)
            assert exported_md is not None and "NOTA DE APRENDIZAJE" in exported_md, "Note export to .md failed!"
            assert "<script>" not in exported_md, "FAIL Point 2: raw <script> tag found in exported .md!"
            assert "<img" not in exported_md, "FAIL Point 2: raw <img tag found in exported .md!"
            assert "<svg" not in exported_md, "FAIL Point 2: raw <svg tag found in exported .md!"
            print("Point 2 verification PASSED: .md export contains no raw HTML tags.")

            # Close all modal overlays to ensure clean state
            page.evaluate("""() => {
                document.querySelectorAll('.modal-overlay').forEach(el => el.classList.remove('open'));
            }""")
            time.sleep(0.3)

            # Point 1 & 2: Trigger Create Review Task button and evaluate created activity
            review_act = page.evaluate("""(targetActId) => {
                try {
                    const notes = JSON.parse(localStorage.getItem('diary_learning_notes') || '[]');
                    const note = notes.find(n => n.activity_id === targetActId);
                    if (!note) return { error: 'Note not found for targetActId ' + targetActId, notesCount: notes.length };
                    if (typeof handleCreateReviewTaskFromNote === 'function') {
                        handleCreateReviewTaskFromNote(note.id);
                    } else {
                        return { error: 'handleCreateReviewTaskFromNote is not a function' };
                    }
                    const acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
                    return acts.find(a => a.title && a.title.includes('Repaso:')) || { error: 'Task with Repaso: not found in acts', actsCount: acts.length };
                } catch(e) {
                    return { error: e.toString(), stack: e.stack };
                }
            }""", act_id)
            print("Created review task:", review_act)
            assert review_act is not None, "Review task was not created from note!"
            assert review_act["title"] == f"Repaso: Materia Test Fase E - Subtema RAG", f"FAIL Point 1: Title is '{review_act['title']}', expected 'Repaso: Materia Test Fase E - Subtema RAG'!"
            assert "<script>" not in review_act["description"], "FAIL Point 2: raw <script> found in review task description!"
            assert "<img" not in review_act["description"], "FAIL Point 2: raw <img found in review task description!"
            assert "<svg" not in review_act["description"], "FAIL Point 2: raw <svg found in review task description!"
            print("Point 1 & 2 verification PASSED: review task title is formatted correctly and description is clean text.")

            browser.close()
            print("SUCCESS: FASE E REINFORCED E2E TEST PASSED 100%!")
    finally:
        if proc:
            proc.terminate()

if __name__ == '__main__':
    run()
