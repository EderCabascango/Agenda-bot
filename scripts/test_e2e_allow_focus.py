import os
import sys
import time
import json
import subprocess
import urllib.request
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
    print("Testing Point 2: allow_focus multi-context migration sync (Context A -> Context B)...")
    proc = ensure_server()
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            
            # Context A & Context B
            ctxA = browser.new_context()
            ctxB = browser.new_context()
            
            pageA = ctxA.new_page()
            pageB = ctxB.new_page()
            
            pageA.goto('http://127.0.0.1:8000/?e2e=1')
            pageB.goto('http://127.0.0.1:8000/?e2e=1')
            
            pageA.wait_for_load_state("networkidle")
            pageB.wait_for_load_state("networkidle")

            # Init settings on both pages
            init_settings = """() => {
                localStorage.setItem('diary_last_sync', '0');
                localStorage.setItem('diary_settings', JSON.stringify({ backendUrl: window.location.origin }));
            }"""
            pageA.evaluate(init_settings)
            pageB.evaluate(init_settings)
            
            # 1. Seed 4 activities with specific tags on pageA
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
            pageA.evaluate(script_seed_4)
            pageA.goto('http://127.0.0.1:8000/?e2e=1')
            pageA.wait_for_load_state("networkidle")
            time.sleep(0.5)
            
            # Check button count on Context A
            btn_dormir = pageA.locator('[data-agenda-focus="act-dormir"]').count()
            btn_correr = pageA.locator('[data-agenda-focus="act-correr"]').count()
            btn_ingles = pageA.locator('[data-agenda-focus="act-ingles"]').count()
            btn_proyectos = pageA.locator('[data-agenda-focus="act-proyectos"]').count()
            
            print(f"Button 'Dormir' (salud): {btn_dormir} (expected 0)")
            print(f"Button 'Correr' (salud): {btn_correr} (expected 0)")
            print(f"Button 'Inglés' (idiomas): {btn_ingles} (expected 1)")
            print(f"Button 'Estudiar/Proyectos' (proyectos): {btn_proyectos} (expected 1)")
            
            assert btn_dormir == 0, "Dormir should NOT have focus button"
            assert btn_correr == 0, "Correr should NOT have focus button"
            assert btn_ingles == 1, "Inglés MUST have focus button"
            assert btn_proyectos == 1, "Estudiar/Proyectos MUST have focus button"

            # 2. Seed legacy activities properly via queue & async sync on Context A
            ts_id = int(time.time())
            id_comer = f"legacy-comer-{ts_id}"
            id_descansar = f"legacy-descansar-{ts_id}"

            script_create_legacy = f"""async () => {{
                const nowIso = new Date().toISOString();
                const legacyComer = {{
                    id: '{id_comer}',
                    title: 'Comer',
                    tags: ['salud'],
                    allow_focus: true,
                    allow_focus_migrated: false,
                    completed: false,
                    date: '2026-10-10',
                    base_version: 0,
                    version: 1,
                    updated_at: nowIso,
                    collection: 'activities'
                }};
                const legacyDescansar = {{
                    id: '{id_descansar}',
                    title: 'Descansar',
                    tags: ['salud'],
                    allow_focus: true,
                    allow_focus_migrated: false,
                    completed: false,
                    date: '2026-10-10',
                    base_version: 0,
                    version: 1,
                    updated_at: nowIso,
                    collection: 'activities'
                }};
                
                let q = JSON.parse(localStorage.getItem('diary_sync_queue') || '[]').filter(x => !x.id.startsWith('legacy-'));
                q.push(legacyComer, legacyDescansar);
                localStorage.setItem('diary_sync_queue', JSON.stringify(q));
                
                const acts = JSON.parse(localStorage.getItem('diary_activities') || '[]').filter(x => !x.id.startsWith('legacy-'));
                acts.push(legacyComer, legacyDescansar);
                localStorage.setItem('diary_activities', JSON.stringify(acts));
                if (window.activities) {{
                    window.activities.length = 0;
                    window.activities.push(...acts);
                }}
                
                if (window.syncWithBackend) await window.syncWithBackend();
            }}"""
            pageA.evaluate(script_create_legacy)

            # Sync Context B to receive initial legacy activities
            pageB.evaluate("async () => { localStorage.setItem('diary_last_sync', '0'); if (window.syncWithBackend) await window.syncWithBackend(); }")

            # Trigger migration check on Context A
            pageA.evaluate("() => window.checkAndProposeAllowFocusMigration()")
            time.sleep(0.5)

            # Modal must be visible on Context A
            modal_overlay = pageA.locator('#modal-migration-allow-focus-overlay')
            assert modal_overlay.is_visible(), "Migration modal should open on Context A"

            # Uncheck descansar as an exception on Context A
            descansar_cb = pageA.locator(f'input.migration-activity-checkbox[value="{id_descansar}"]')
            assert descansar_cb.is_visible(), "Checkbox for legacy-descansar missing"
            descansar_cb.uncheck()

            # Click Apply on Context A and await sync completion
            pageA.locator('#btn-apply-migration').click()
            time.sleep(0.5)
            pageA.evaluate("async () => { if (window.syncWithBackend) await window.syncWithBackend(); }")
            time.sleep(0.5)

            assert not modal_overlay.is_visible(), "Modal should close on Context A"

            # Verify local saved state on Context A
            saved_actsA = pageA.evaluate("() => JSON.parse(localStorage.getItem('diary_activities') || '[]')")
            comerA = next((a for a in saved_actsA if a['id'] == id_comer), None)
            descansarA = next((a for a in saved_actsA if a['id'] == id_descansar), None)

            assert comerA is not None and comerA['allow_focus'] is False, "Context A: Comer should have allow_focus = False"
            assert comerA['allow_focus_migrated'] is True, "Context A: Comer should have allow_focus_migrated = True"
            assert descansarA is not None and descansarA['allow_focus'] is True, "Context A: Descansar (exception) should retain allow_focus = True"

            # Trigger sync on Context B and verify sync propagation
            pageB.evaluate("async () => { localStorage.setItem('diary_last_sync', '0'); if (window.syncWithBackend) await window.syncWithBackend(); }")

            saved_actsB = pageB.evaluate("() => JSON.parse(localStorage.getItem('diary_activities') || '[]')")
            comerB = next((a for a in saved_actsB if a['id'] == id_comer), None)
            descansarB = next((a for a in saved_actsB if a['id'] == id_descansar), None)

            print("Full comerB object:", json.dumps(comerB, indent=2))
            print(f"Context B received legacy-comer allow_focus: {comerB['allow_focus'] if (comerB and 'allow_focus' in comerB) else None} (expected False)")
            print(f"Context B received legacy-descansar allow_focus: {descansarB['allow_focus'] if (descansarB and 'allow_focus' in descansarB) else None} (expected True)")

            assert comerB is not None and comerB['allow_focus'] is False, "Context B MUST receive allow_focus = False for migrated task"
            assert descansarB is not None and descansarB['allow_focus'] is True, "Context B MUST receive allow_focus = True for exception task"

            browser.close()
            print("Point 2 allow_focus multi-context migration sync verification PASSED 100%!")
    finally:
        if proc:
            proc.terminate()

if __name__ == '__main__':
    run()
