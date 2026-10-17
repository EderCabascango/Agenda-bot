"""E2E: Excel sin depender de internet.

1. SheetJS (web/vendor/xlsx.full.min.js) carga desde el propio servidor y la CSP no bloquea nada.
2. "Descargar plantilla" genera un .xlsx válido.
3. Importar esa misma plantilla crea las actividades de la rutina en el rango de fechas elegido.
"""
import os
import tempfile

from playwright.sync_api import sync_playwright
from test_server import TestServerRunner


def run():
    print("Testing Excel (plantilla e importación) con SheetJS local...")
    server = TestServerRunner().start()
    tmp_dir = tempfile.mkdtemp(prefix="agenda_excel_")

    try:
        with sync_playwright() as p:
            browser = server.launch_browser(p)
            context = browser.new_context(accept_downloads=True)
            page = context.new_page()

            csp_errors, external_requests = [], []
            page.on("console", lambda m: csp_errors.append(m.text) if "Content Security Policy" in m.text else None)
            page.on("request", lambda r: external_requests.append(r.url) if not r.url.startswith(server.url) and not r.url.startswith("data:") else None)

            page.goto(f"{server.url}/?e2e=1")
            page.wait_for_load_state("networkidle")

            # ── 1. Librería local ──
            version = page.evaluate("() => window.XLSX && window.XLSX.version")
            assert version == "0.20.3", f"SheetJS debe cargarse en local (versión 0.20.3), se obtuvo {version!r}"
            assert not csp_errors, f"La CSP bloqueó recursos: {csp_errors}"
            assert not external_requests, f"La app no debe pedir recursos externos: {external_requests}"
            print(f"  [OK] SheetJS {version} cargado desde el servidor, sin errores de CSP ni peticiones externas.")

            # ── 2. Descargar plantilla ──
            page.evaluate("() => document.getElementById('btn-open-routine-modal').click()")
            page.wait_for_selector('#routine-overlay.open')
            with page.expect_download() as dl_info:
                page.click('#btn-download-template')
            download = dl_info.value
            template_path = os.path.join(tmp_dir, download.suggested_filename)
            download.save_as(template_path)
            assert download.suggested_filename == "plantilla_rutina_semanal.xlsx"
            with open(template_path, "rb") as f:
                assert f.read(2) == b"PK", "El archivo descargado debe ser un .xlsx (zip)"
            print(f"  [OK] Plantilla descargada: {download.suggested_filename} ({os.path.getsize(template_path)} bytes).")

            # ── 3. Importar la plantilla en un rango de 7 días ──
            page.fill('#routine-start-date', '2026-11-02')  # lunes
            page.fill('#routine-end-date', '2026-11-08')    # domingo
            page.evaluate("() => { const c = document.getElementById('routine-clear-existing'); if (c) c.checked = true; }")
            page.on("dialog", lambda d: d.accept())
            page.set_input_files('#routine-file-input', template_path)
            page.wait_for_function("""() => {
                const acts = JSON.parse(localStorage.getItem('diary_activities') || '[]');
                return acts.some(a => a.date >= '2026-11-02' && a.date <= '2026-11-08');
            }""", timeout=10000)

            summary = page.evaluate("""() => {
                const acts = JSON.parse(localStorage.getItem('diary_activities') || '[]')
                    .filter(a => !a.deleted_at && a.date >= '2026-11-02' && a.date <= '2026-11-08');
                const dates = [...new Set(acts.map(a => a.date))].sort();
                const mondayTitles = acts.filter(a => a.date === '2026-11-02').map(a => a.title);
                return { total: acts.length, dates, mondayTitles };
            }""")
            assert len(summary["dates"]) == 7, f"Debe haber actividades los 7 días: {summary['dates']}"
            assert "AI-300" in summary["mondayTitles"], f"El lunes debe incluir 'AI-300' de la plantilla: {summary['mondayTitles']}"
            assert "Dormir" in summary["mondayTitles"]
            assert not csp_errors, f"La CSP bloqueó recursos durante la importación: {csp_errors}"
            print(f"  [OK] Plantilla importada: {summary['total']} actividades en {len(summary['dates'])} días.")

            browser.close()
            print("Excel: verificación PASSED 100%!")
    finally:
        server.stop()


if __name__ == '__main__':
    run()
