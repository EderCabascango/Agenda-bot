"""Genera screenshots/design/*.png desde design/mockup.html (viewport, no fullPage)
y reporta scrollWidth vs clientWidth de la pagina."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "screenshots" / "design"
OUT.mkdir(parents=True, exist_ok=True)
URL = (ROOT / "design" / "mockup.html").as_uri()

SCREENS = ["dashboard", "week", "subject"]
THEMES = ["light", "dark"]
VIEWPORTS = [("1280", 1280, 800), ("390", 390, 844)]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for vp_name, w, h in VIEWPORTS:
        page = browser.new_page(viewport={"width": w, "height": h})
        for screen in SCREENS:
            for theme in THEMES:
                page.goto(f"{URL}?screen={screen}&theme={theme}")
                page.wait_for_load_state("load")
                over = page.evaluate("() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]")
                name = f"design_{screen}_{vp_name}_{theme}.png"
                page.screenshot(path=str(OUT / name))
                flag = "OK" if over[0] <= over[1] else "DESBORDE"
                print(f"{name}  scrollWidth={over[0]} clientWidth={over[1]} {flag}")
        page.close()
    browser.close()
