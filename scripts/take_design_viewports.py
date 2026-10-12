import os
import time
from playwright.sync_api import sync_playwright
from test_server import TestServerRunner

def run():
    print("Capturing design viewports (1280 & 390, light & dark)...")
    server = TestServerRunner().start()
    os.makedirs('screenshots/design_viewports', exist_ok=True)
    
    viewports = [
        ('1280', {'width': 1280, 'height': 850}),
        ('390', {'width': 390, 'height': 844})
    ]
    
    themes = ['light', 'dark']
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            
            for vp_name, vp_size in viewports:
                for theme in themes:
                    page = browser.new_page(viewport=vp_size)
                    page.goto(f"{server.url}/?e2e=1")
                    page.wait_for_load_state("networkidle")
                    
                    # Set theme
                    if theme == 'dark':
                        page.evaluate("() => document.documentElement.setAttribute('data-theme', 'dark')")
                    else:
                        page.evaluate("() => document.documentElement.removeAttribute('data-theme')")
                    time.sleep(0.3)
                    
                    # 1. Dashboard
                    page.screenshot(path=f'screenshots/design_viewports/{vp_name}_{theme}_dashboard.png')
                    
                    # 2. Estudio (Materias)
                    page.click('button[data-view="study"]')
                    page.wait_for_selector('#subtab-btn-subjects')
                    page.click('#subtab-btn-subjects')
                    time.sleep(0.3)
                    page.screenshot(path=f'screenshots/design_viewports/{vp_name}_{theme}_study.png')
                    
                    # 3. Detalle de Materia
                    first_sub = page.locator('.subject-card').first
                    if first_sub.count() > 0:
                        first_sub.click()
                        time.sleep(0.4)
                        page.screenshot(path=f'screenshots/design_viewports/{vp_name}_{theme}_subject_detail.png')
                        page.click('#detail-subject-close')
                        time.sleep(0.2)
                    
                    # 4. Estadísticas
                    page.click('#subtab-btn-stats')
                    page.wait_for_selector('#study-stats-container')
                    time.sleep(0.3)
                    page.screenshot(path=f'screenshots/design_viewports/{vp_name}_{theme}_stats.png')
                    
                    # 5. Temporizador (Setup / Active Modal)
                    page.evaluate("() => openFocusModal()")
                    page.wait_for_selector('#modal-focus-timer')
                    time.sleep(0.3)
                    page.screenshot(path=f'screenshots/design_viewports/{vp_name}_{theme}_timer.png')
                    page.click('#focus-timer-close')
                    
                    page.close()
                    
            browser.close()
            print("All design viewport screenshots captured in screenshots/design_viewports/!")
    finally:
        server.stop()

if __name__ == '__main__':
    run()
