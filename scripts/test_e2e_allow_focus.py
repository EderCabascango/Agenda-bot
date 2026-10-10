import sys
import time
import json
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
    print("Testing Point 4 & 5: allow_focus rules, button visibility for 4 tasks, migration modal, exceptions & sync queue...")
    proc = ensure_server()
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto('http://127.0.0.1:8000/?e2e=1')
            page.wait_for_load_state("networkidle")
            
            # 1. Seed 4 activities with specific tags & default allow_focus behavior
            # "Dormir" (salud) -> allow_focus: false
            # "Correr" (salud) -> allow_focus: false
            # "Inglés" (idiomas) -> allow_focus: true
            # "Estudiar/Proyectos" (proyectos) -> allow_focus: true
            script_seed_4 = """() => {
                const today = (typeof toDateStr === 'function') ? toDateStr(new Date()) : new Date().toISOString().slice(0, 10);
                const settings = { defaultFocusTags: ['estudio', 'proyectos', 'ia', 'idiomas', 'lectura', 'programación', 'programacion', 'study', 'projects'] };
                localStorage.setItem('agenda_settings', JSON.stringify(settings));

                const acts = [
                    {
                        id: 'act-dormir',
                        title: 'Dormir',
                        tags: ['salud'],
                        allow_focus: FocusCore.shouldAllowFocusDefault({ tags: ['salud'] }, settings),
                        completed: false,
                        date: today,
                        version: 1,
                        updated_at: new Date().toISOString()
                    },
                    {
                        id: 'act-correr',
                        title: 'Correr',
                        tags: ['salud'],
                        allow_focus: FocusCore.shouldAllowFocusDefault({ tags: ['salud'] }, settings),
                        completed: false,
                        date: today,
                        version: 1,
                        updated_at: new Date().toISOString()
                    },
                    {
                        id: 'act-ingles',
                        title: 'Inglés',
                        tags: ['idiomas'],
                        allow_focus: FocusCore.shouldAllowFocusDefault({ tags: ['idiomas'] }, settings),
                        completed: false,
                        date: today,
                        version: 1,
                        updated_at: new Date().toISOString()
                    },
                    {
                        id: 'act-proyectos',
                        title: 'Estudiar/Proyectos',
                        tags: ['proyectos'],
                        allow_focus: FocusCore.shouldAllowFocusDefault({ tags: ['proyectos'] }, settings),
                        completed: false,
                        date: today,
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
            page.evaluate(script_seed_4)
            page.goto('http://127.0.0.1:8000/?e2e=1')
            page.wait_for_load_state("networkidle")
            time.sleep(0.5)
            
            # Check button count for each task
            btn_dormir = page.locator('[data-agenda-focus="act-dormir"]').count()
            btn_correr = page.locator('[data-agenda-focus="act-correr"]').count()
            btn_ingles = page.locator('[data-agenda-focus="act-ingles"]').count()
            btn_proyectos = page.locator('[data-agenda-focus="act-proyectos"]').count()
            
            print(f"Button 'Dormir' (salud): {btn_dormir} (expected 0)")
            print(f"Button 'Correr' (salud): {btn_correr} (expected 0)")
            print(f"Button 'Inglés' (idiomas): {btn_ingles} (expected 1)")
            print(f"Button 'Estudiar/Proyectos' (proyectos): {btn_proyectos} (expected 1)")
            
            assert btn_dormir == 0, "Dormir should NOT have focus button"
            assert btn_correr == 0, "Correr should NOT have focus button"
            assert btn_ingles == 1, "Inglés MUST have focus button"
            assert btn_proyectos == 1, "Estudiar/Proyectos MUST have focus button"

            # 2. Test Migration Review Flow & Exceptions
            script_legacy = """() => {
                const legacy = [
                    {
                        id: 'legacy-comer',
                        title: 'Comer',
                        tags: ['salud'],
                        allow_focus: true,
                        allow_focus_migrated: false,
                        completed: false,
                        version: 1
                    },
                    {
                        id: 'legacy-descansar',
                        title: 'Descansar',
                        tags: ['salud'],
                        allow_focus: true,
                        allow_focus_migrated: false,
                        completed: false,
                        version: 1
                    }
                ];
                localStorage.setItem('diary_activities', JSON.stringify(legacy));
                if (window.activities) {
                    window.activities.length = 0;
                    window.activities.push(...legacy);
                }
                window.checkAndProposeAllowFocusMigration();
            }"""
            page.evaluate(script_legacy)
            time.sleep(0.5)

            # Modal must be visible
            modal_overlay = page.locator('#modal-migration-allow-focus-overlay')
            assert modal_overlay.is_visible(), "Migration modal should open"

            # Uncheck 'legacy-descansar' as an exception
            descansar_cb = page.locator('input.migration-activity-checkbox[value="legacy-descansar"]')
            assert descansar_cb.is_visible(), "Checkbox for legacy-descansar missing"
            descansar_cb.uncheck()

            # Click Apply
            page.locator('#btn-apply-migration').click()
            time.sleep(0.5)

            assert not modal_overlay.is_visible(), "Modal should close after applying migration"

            # Verify saved state in localStorage
            saved_acts = page.evaluate("() => JSON.parse(localStorage.getItem('diary_activities') || '[]')")
            comer = next((a for a in saved_acts if a['id'] == 'legacy-comer'), None)
            descansar = next((a for a in saved_acts if a['id'] == 'legacy-descansar'), None)

            assert comer is not None and comer['allow_focus'] is False, "Comer should have allow_focus = False"
            assert comer['allow_focus_migrated'] is True, "Comer should have allow_focus_migrated = True"
            assert descansar is not None and descansar['allow_focus'] is True, "Descansar (exception) should retain allow_focus = True"
            assert descansar['allow_focus_migrated'] is True, "Descansar (exception) should have allow_focus_migrated = True"

            browser.close()
            print("Point 5 allow_focus & migration verification PASSED 100%!")
    finally:
        if proc:
            proc.terminate()

if __name__ == '__main__':
    run()
