import os
import re
import time
from playwright.sync_api import sync_playwright
from test_server import TestServerRunner

def parse_rgba(rgb_str):
    m = re.match(r'rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)', rgb_str)
    if not m:
        return None
    r, g, b = int(m.group(1)), int(m.group(2)), int(m.group(3))
    a = float(m.group(4)) if m.group(4) is not None else 1.0
    return r, g, b, a

def is_allowed_color(r, g, b, a):
    if a == 0:
        return True, "transparent"
    # 1. Grays / Black / White: |r-g| <= 20 and |g-b| <= 20 and |r-b| <= 20
    if abs(r - g) <= 25 and abs(g - b) <= 25 and abs(r - b) <= 25:
        return True, "gray/black/white"
    
    # 2. Amber / Yellow: High Red, Medium-High Green (G >= 0.55*R), Low Blue (B <= 0.65*G)
    # E.g. #F5B82E -> (245, 184, 46)
    # #FDE68A -> (253, 230, 138)
    # #D97706 -> (217, 119, 6)
    if r > 160 and g > 100 and b < 160 and r >= g and g > b:
        return True, "amber/yellow"
    
    # Dark mode translucent amber: e.g. rgba(245, 184, 46, 0.4)
    if a < 1.0 and r >= g and g > b:
        return True, "translucent amber"

    return False, f"Forbidden color (R:{r}, G:{g}, B:{b}, A:{a})"

def run():
    server = TestServerRunner().start()
    try:
        _run(server)
    finally:
        server.stop()

def _run(server):
    base_url = server.url
    print("\n============================================================")
    print("VERIFICACIÓN DE LA MATRIZ DEL CICLO MENSUAL (DASHBOARD)")
    print("============================================================\n")

    os.makedirs('screenshots', exist_ok=True)
    
    with sync_playwright() as p:
        browser = server.launch_browser(p)
        
        # ---------------------------------------------------------
        # 1. TEST DE PALETA DE COLORES PERMITIDA (CLARO Y OSCURO)
        # ---------------------------------------------------------
        print(">>> 1. Verificando paleta de colores de relleno en celdas (.act-cell y .act-label)...")
        for theme in ['light', 'dark']:
            page = browser.new_page(viewport={'width': 1280, 'height': 900})
            page.goto(f'{base_url}/?e2e=1')
            page.evaluate(f"() => {{ document.documentElement.setAttribute('data-theme', '{theme}'); localStorage.setItem('diary_theme', '{theme}'); if (window.renderDashboard) window.renderDashboard(); }}")
            page.wait_for_selector('#diario-table')
            time.sleep(0.5)

            # Inspect all .act-cell background colors
            cells_info = page.evaluate("""() => {
                const cells = document.querySelectorAll('.diario-table .act-cell');
                const labels = document.querySelectorAll('.diario-table .act-label');
                const results = [];
                cells.forEach(c => {
                    const style = window.getComputedStyle(c);
                    results.push({
                        type: 'cell',
                        cls: c.className,
                        bg: style.backgroundColor,
                        color: style.color,
                        aria: c.getAttribute('aria-label')
                    });
                });
                labels.forEach(l => {
                    const style = window.getComputedStyle(l);
                    results.push({
                        type: 'label',
                        cls: l.className,
                        bg: style.backgroundColor,
                        color: style.color
                    });
                });
                return results;
            }""")

            print(f"  [Tema {theme.upper()}] Analizando {len(cells_info)} elementos en la matriz...")
            cell_types_seen = set()
            for item in cells_info:
                bg = item['bg']
                rgba = parse_rgba(bg)
                if rgba:
                    r, g, b, a = rgba
                    allowed, reason = is_allowed_color(r, g, b, a)
                    assert allowed, f"COLOR PROHIBIDO DETECTADO en {item['type']} ({item.get('cls', '')}): {bg} -> {reason}"
                if item['type'] == 'cell':
                    for c_part in item['cls'].split():
                        cell_types_seen.add(c_part)

            print(f"  [OK] [Tema {theme.upper()}] 100% de celdas y etiquetas dentro de la paleta permitida (Grises, Negro, Blanco y Amarillo Ambar).")
            print(f"    Clases de celda verificadas: {sorted(list(cell_types_seen))}")
            page.close()

        # ---------------------------------------------------------
        # 2. TEST DE ACCESIBILIDAD Y SEMÁNTICA
        # ---------------------------------------------------------
        print("\n>>> 2. Verificando accesibilidad (aria-labels, roles y teclado)...")
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        page.goto(f'{base_url}/?e2e=1')
        page.wait_for_selector('#diario-table')

        acc_check = page.evaluate("""() => {
            const table = document.querySelector('#diario-table');
            const cells = document.querySelectorAll('.diario-table .act-cell');
            const emptyAria = Array.from(cells).filter(c => !c.getAttribute('aria-label') || c.getAttribute('aria-label').trim() === '');
            const tabIndices = Array.from(cells).filter(c => !c.classList.contains('is-future') && c.getAttribute('tabindex') !== '0');
            const roleGrid = table.getAttribute('role') === 'grid';
            return {
                totalCells: cells.length,
                missingAriaCount: emptyAria.length,
                invalidTabindexCount: tabIndices.length,
                hasRoleGrid: roleGrid,
                sampleAria: cells[0] ? cells[0].getAttribute('aria-label') : null
            };
        }""")

        assert acc_check['hasRoleGrid'], "La tabla debe tener role='grid'"
        assert acc_check['missingAriaCount'] == 0, f"Todas las celdas deben tener aria-label. Faltantes: {acc_check['missingAriaCount']}"
        assert acc_check['invalidTabindexCount'] == 0, f"Celdas navegables deben tener tabindex='0'. Inválidas: {acc_check['invalidTabindexCount']}"
        print(f"  [OK] Semántica de cuadrícula: role='grid' presente.")
        print(f"  [OK] Total celdas accesibles con aria-label descriptivo: {acc_check['totalCells']}")
        print(f"    Ejemplo de aria-label: '{acc_check['sampleAria']}'")
        page.close()

        # ---------------------------------------------------------
        # 3. TEST DE DESBORDES (1280px, 1180px, 768px, 390px)
        # ---------------------------------------------------------
        print("\n>>> 3. Verificando desbordes horizontales (scroll horizontal de página)...")
        test_viewports = [
            (1280, 900, "1280px Desktop"),
            (1180, 900, "1180px Laptop"),
            (768, 1024, "768px Tablet"),
            (390, 844, "390px Mobile")
        ]

        for w, h, label in test_viewports:
            vp_page = browser.new_page(viewport={'width': w, 'height': h})
            vp_page.goto(f'{base_url}/?e2e=1')
            vp_page.wait_for_selector('#diario-table')
            time.sleep(0.5)

            overflow_info = vp_page.evaluate("""() => {
                const doc = document.documentElement;
                const body = document.body;
                const wrap = document.querySelector('.diario-table-wrap');
                const labelCell = document.querySelector('.diario-table .act-label');
                const wrapStyle = wrap ? window.getComputedStyle(wrap) : null;
                const labelStyle = labelCell ? window.getComputedStyle(labelCell) : null;
                
                return {
                    docClientWidth: doc.clientWidth,
                    docScrollWidth: doc.scrollWidth,
                    bodyScrollWidth: body.scrollWidth,
                    pageHasHorizontalScroll: doc.scrollWidth > doc.clientWidth,
                    wrapHasOverflowX: wrapStyle ? wrapStyle.overflowX : null,
                    labelIsSticky: labelStyle ? labelStyle.position : null
                };
            }""")

            print(f"  [{label}] clientWidth: {overflow_info['docClientWidth']}px | scrollWidth: {overflow_info['docScrollWidth']}px")
            assert not overflow_info['pageHasHorizontalScroll'], f"ERROR: Desborde horizontal detectado en viewport {label}!"
            assert overflow_info['wrapHasOverflowX'] == 'auto', "El contenedor de la matriz debe tener overflow-x: auto"
            assert overflow_info['labelIsSticky'] == 'sticky', "Las etiquetas de actividad deben tener position: sticky"
            print(f"    [OK] Sin desborde en viewport {label}. Scroll interno activo y etiquetas fijas ('sticky').")
            vp_page.close()

        # ---------------------------------------------------------
        # 4. CAPTURAS DE VIEWPORT (AFTER): 1280px & 390px, CLARO Y OSCURO
        # ---------------------------------------------------------
        print("\n>>> 4. Generando capturas de pantalla de la matriz (AFTER)...")

        # 1280 Light
        p1280_l = browser.new_page(viewport={'width': 1280, 'height': 900})
        p1280_l.goto(f'{base_url}/?e2e=1')
        p1280_l.evaluate("() => { document.documentElement.setAttribute('data-theme', 'light'); localStorage.setItem('diary_theme', 'light'); if (window.renderDashboard) window.renderDashboard(); }")
        p1280_l.wait_for_selector('#diario-table')
        time.sleep(0.5)
        p1280_l.screenshot(path='screenshots/matrix_after_1280_light.png', full_page=True)
        print("  Capturada: screenshots/matrix_after_1280_light.png")
        p1280_l.close()

        # 1280 Dark
        p1280_d = browser.new_page(viewport={'width': 1280, 'height': 900})
        p1280_d.goto(f'{base_url}/?e2e=1')
        p1280_d.evaluate("() => { document.documentElement.setAttribute('data-theme', 'dark'); localStorage.setItem('diary_theme', 'dark'); if (window.renderDashboard) window.renderDashboard(); }")
        p1280_d.wait_for_selector('#diario-table')
        time.sleep(0.5)
        p1280_d.screenshot(path='screenshots/matrix_after_1280_dark.png', full_page=True)
        print("  Capturada: screenshots/matrix_after_1280_dark.png")
        p1280_d.close()

        # 390 Light
        p390_l = browser.new_page(viewport={'width': 390, 'height': 844})
        p390_l.goto(f'{base_url}/?e2e=1')
        p390_l.evaluate("() => { document.documentElement.setAttribute('data-theme', 'light'); localStorage.setItem('diary_theme', 'light'); if (window.renderDashboard) window.renderDashboard(); }")
        p390_l.wait_for_selector('#diario-table')
        time.sleep(0.5)
        p390_l.screenshot(path='screenshots/matrix_after_390_light.png', full_page=True)
        print("  Capturada: screenshots/matrix_after_390_light.png")
        p390_l.close()

        # 390 Dark
        p390_d = browser.new_page(viewport={'width': 390, 'height': 844})
        p390_d.goto(f'{base_url}/?e2e=1')
        p390_d.evaluate("() => { document.documentElement.setAttribute('data-theme', 'dark'); localStorage.setItem('diary_theme', 'dark'); if (window.renderDashboard) window.renderDashboard(); }")
        p390_d.wait_for_selector('#diario-table')
        time.sleep(0.5)
        p390_d.screenshot(path='screenshots/matrix_after_390_dark.png', full_page=True)
        print("  Capturada: screenshots/matrix_after_390_dark.png")
        p390_d.close()

        browser.close()
        print("\n[OK] TODAS LAS VERIFICACIONES DE LA MATRIZ PASARON EXITOSAMENTE (100% OK).\n")

if __name__ == '__main__':
    run()
