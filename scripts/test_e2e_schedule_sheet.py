import os
import sys
import time
sys.path.insert(0, os.path.dirname(__file__))
from test_server import TestServerRunner
from playwright.sync_api import sync_playwright

def run():
    server = TestServerRunner(prefix="agenda_schedule_test_")
    server.start()
    try:
        with sync_playwright() as p:
            browser = server.launch_browser(p)
            page = browser.new_page(viewport={"width": 1366, "height": 920})
            page.goto(f"{server.url}/?e2e=1")
            page.wait_for_load_state("networkidle")

            # Navigate to Horario Semanal
            page.locator('.nav-item[data-view="schedule"]').click()
            page.wait_for_selector("#schedule-sheet-tbody tr")

            rows = page.locator("#schedule-sheet-tbody tr").count()
            print("Rows rendered in Horario Semanal:", rows)
            assert rows == 17, f"Expected 17 rows, got {rows}"

            ref = page.locator("#excel-cell-ref").text_content()
            val = page.locator("#excel-formula-input").input_value()
            print(f"Active cell: {ref} = {val}")

            # Edit cell B1 via formula bar
            page.locator("#excel-formula-input").fill("Python & IA")
            cell_text = page.locator('td.sheet-cell[data-row="0"][data-col="1"] .sheet-cell-text').text_content()
            print("Updated B1 text:", cell_text)
            assert cell_text == "Python & IA"

            # Restore base schedule
            page.locator("#btn-schedule-reset").click()
            page.locator("#confirm-action-ok").click()
            restored_text = page.locator('td.sheet-cell[data-row="0"][data-col="1"] .sheet-cell-text').text_content()
            print("Restored B1 text:", restored_text)
            assert restored_text == "Dormir"

            # Select cell F13 (Viernes, 15:40 - 16:20 -> Benja Recorrido) like in the user screenshot
            page.locator('td.sheet-cell[data-row="11"][data-col="5"]').click()
            os.makedirs("screenshots", exist_ok=True)
            page.screenshot(path="screenshots/horario_semanal_excel.png", full_page=True)

            # Apply schedule to agenda
            page.locator("#btn-schedule-apply-agenda").click()
            page.locator("#confirm-action-ok").click()
            time.sleep(0.5)

            acts_count = page.evaluate('() => JSON.parse(localStorage.getItem("diary_activities") || "[]").filter(a => !a.deleted_at).length')
            print("Activities created in agenda for the week:", acts_count)
            assert acts_count > 50, f"Expected > 50 activities, got {acts_count}"

            browser.close()
            print("SCHEDULE EXCEL E2E PASSED 100%!")
    finally:
        server.stop()

if __name__ == "__main__":
    run()
