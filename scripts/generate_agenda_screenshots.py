import os
import time
from playwright.sync_api import sync_playwright
from test_server import TestServerRunner

def run():
    print("Generating Agenda de Hoy screenshots at 1280px and 390px viewports...")
    server = TestServerRunner().start()
    try:
        with sync_playwright() as p:
            browser = server.launch_browser(p)
            
            # 1280px Desktop
            page1280 = browser.new_page(viewport={"width": 1280, "height": 800})
            page1280.goto(f"{server.url}/?e2e=1")
            page1280.wait_for_load_state("networkidle")
            
            script_seed = """() => {
                const today = (typeof toDateStr === 'function') ? toDateStr(new Date()) : new Date().toISOString().slice(0, 10);
                const settings = { defaultFocusTags: ['estudio', 'proyectos', 'ia', 'idiomas', 'lectura', 'programación', 'programacion', 'study', 'projects'] };
                localStorage.setItem('agenda_settings', JSON.stringify(settings));

                const acts = [
                    {
                        id: 'act-dormir',
                        title: 'Dormir ocho horas',
                        tags: ['salud'],
                        allow_focus: false,
                        completed: false,
                        date: today,
                        time: '07:00 - 08:00',
                        version: 1,
                        updated_at: new Date().toISOString()
                    },
                    {
                        id: 'act-ingles',
                        title: 'Estudiar Gramática de Inglés',
                        tags: ['idiomas'],
                        allow_focus: true,
                        completed: false,
                        date: today,
                        time: '09:00 - 10:00',
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
            page1280.evaluate(script_seed)
            page1280.reload()
            page1280.wait_for_load_state("networkidle")
            time.sleep(0.5)
            page1280.screenshot(path="screenshots/agenda_today_1280.png")
            print("Captured screenshots/agenda_today_1280.png")

            # 390px Mobile
            page390 = browser.new_page(viewport={"width": 390, "height": 844})
            page390.goto(f"{server.url}/?e2e=1")
            page390.wait_for_load_state("networkidle")
            page390.evaluate(script_seed)
            page390.reload()
            page390.wait_for_load_state("networkidle")
            time.sleep(0.5)
            page390.screenshot(path="screenshots/agenda_today_390.png")
            print("Captured screenshots/agenda_today_390.png")

            browser.close()
    finally:
        server.stop()

if __name__ == '__main__':
    run()
