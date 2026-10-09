import os
import time
from playwright.sync_api import sync_playwright

print("=== RUNNING POINT 2 E2E TEST: FASE E FULL FLOW & XSS TEST ===")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    dialogs_triggered = []
    page.on("dialog", lambda d: dialogs_triggered.append(d.message))

    page.goto("http://127.0.0.1:8000/?e2e=1")
    page.wait_for_load_state("networkidle")
    time.sleep(1)

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
    time.sleep(0.5)

    # 1. Simular sesión de enfoque activa finalizada con resumen de notas
    page.evaluate(f"""() => {{
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
            
            const overlay = document.querySelector('#focus-timer-overlay');
            if (overlay) overlay.classList.add('open');
            const setupView = document.querySelector('#focus-setup-view');
            const activeView = document.querySelector('#focus-active-view');
            const summaryView = document.querySelector('#focus-summary-view');
            if (setupView) setupView.style.display = 'none';
            if (activeView) activeView.style.display = 'none';
            if (summaryView) summaryView.style.display = 'block';
        }}
    }}""")
    time.sleep(0.5)

    # 2. Rellenar formulario con payloads XSS y ratings 4 y 5
    page.select_option("#summary-comprehension-level", "4")
    page.select_option("#summary-focus-level", "5")
    page.fill("#summary-learned-text", "Aprendí RAG con <script>alert('xss_note')</script> en vector DB")
    page.fill("#summary-questions-text", "Duda <img src=x onerror=alert('xss_question')> sobre embeddings")
    page.fill("#summary-resources-text", "https://docs.python.org <svg onload=alert('xss_res')>")
    page.fill("#summary-next-step", "Revisar código de prueba")

    # Guardar sesión y notas
    page.click("#btn-save-session-with-notes")
    time.sleep(1)

    # 3. Verificación de seguridad XSS (0 alertas disparadas)
    print("Dialogs disparados (esperados 0):", dialogs_triggered)
    assert len(dialogs_triggered) == 0, "Fallo: se dispararon alertas XSS al guardar la nota!"

    # 4. Verificar que la nota fue creada en localStorage con comprehension_level=4 y focus_level=5
    note_saved = page.evaluate(f"""() => {{
        const notes = JSON.parse(localStorage.getItem('diary_learning_notes') || '[]');
        return notes.find(n => n.activity_id === '{act_id}');
    }}""")
    print("NOTA GUARDADA EN STORAGE:", note_saved)
    assert note_saved is not None, "Fallo: la nota no fue guardada en learning_notes!"
    assert note_saved["comprehension_level"] == 4, f"Fallo: comprehension_level esperado 4, obtenido {note_saved.get('comprehension_level')}"
    assert note_saved["focus_level"] == 5, f"Fallo: focus_level esperado 5, obtenido {note_saved.get('focus_level')}"

    # 5. Verificar que la actividad original NO cambió de versión
    orig_act_ver = page.evaluate(f"""() => {{
        const acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
        const act = acts.find(a => a.id === '{act_id}');
        return act ? act.version : null;
    }}""")
    print("VERSIÓN DE ACTIVIDAD ORIGINAL TRAS NOTA:", orig_act_ver)
    assert orig_act_ver == 1, f"Fallo: la versión de la actividad original cambió de 1 a {orig_act_ver}!"

    # 6. Navegar a Notas de Aprendizaje y presionar el botón de crear tarea de repaso en la tarjeta
    page.click(".nav-item[data-view='study']")
    page.wait_for_selector("#view-study.active", timeout=3000)
    page.evaluate("() => { if (window.switchStudySubtab) window.switchStudySubtab('learning-notes'); }")
    time.sleep(0.5)

    notes_html = page.inner_html("#learning-notes-grid")
    assert "<script>" not in notes_html, "Fallo: script tag sin escapar en el DOM de notas!"
    print("SUCCESS: HTML de la nota neutralizó correctamente las inyecciones XSS.")

    # Hacer clic en el botón [Repaso] de la nota renderizada
    page.click('[data-action="create-review-task"]')
    time.sleep(0.5)

    review_act = page.evaluate("""() => {
        const acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
        return acts.find(a => a.title && a.title.includes('Repaso:'));
    }""")
    print("TAREA DE REPASO CREADA:", review_act)
    assert review_act is not None, "Fallo: no se creó la tarea de repaso a partir de la nota!"

    browser.close()
    print("SUCCESS: FLUJO COMPLETO DE FASE E Y RATINGS 1-5 DEMOSTRADO EXITOSAMENTE.")
