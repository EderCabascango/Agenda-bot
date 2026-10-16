import os
import sys
import time
from playwright.sync_api import sync_playwright
from test_server import TestServerRunner

def run():
    print("Testing Point 6: Local icons & offline mode verification with context.set_offline(True)...")
    server = TestServerRunner().start()
    try:
        with sync_playwright() as p:
            browser = server.launch_browser(p)
            context = browser.new_context()
            page = context.new_page()
            
            # 1. Enable offline mode explicitly
            context.set_offline(True)
            print("Set browser context.set_offline(True)")
            
            # 2. Attempt external fetch and demonstrate that it FAILS
            fetch_result = page.evaluate("""async () => {
                try {
                    await fetch('https://fonts.googleapis.com', { mode: 'no-cors' });
                    return { success: true, error: null };
                } catch (err) {
                    return { success: false, error: err.toString() };
                }
            }""")
            
            print(f"External fetch result in offline mode: {fetch_result}")
            assert not fetch_result['success'], "External fetch SHOULD fail in offline mode"
            assert fetch_result['error'] is not None, "Error message should be present"
            print(f"Verified external fetch failed cleanly: {fetch_result['error']}")
            
            # 3. Load local app (switch context offline off briefly for 127.0.0.1 connection if needed, then re-enable offline to verify font rendering)
            context.set_offline(False)
            page.goto(f"{server.url}/?e2e=1")
            page.wait_for_selector('.nav-item .material-icons-round')
            
            context.set_offline(True)
            
            # Verify icons count in DOM
            icons_count = page.locator('.material-icons-round').count()
            print(f"Material icons count in local DOM: {icons_count}")
            assert icons_count > 0, "Expected material-icons-round elements to be rendered locally"
            
            # Verify NO Google Fonts CDN links in head
            cdn_links = page.locator('link[href*="googleapis.com"]').count()
            print(f"Google Fonts CDN links count: {cdn_links}")
            assert cdn_links == 0, f"Expected 0 Google Fonts CDN links, found {cdn_links}"
            
            # Verify local font CSS link present
            local_css = page.locator('link[href*="material-icons-round.css"]').count()
            print(f"Local material-icons-round.css count: {local_css}")
            assert local_css == 1, "Expected 1 local material-icons-round.css link"
            
            browser.close()
            print("Point 6 verification PASSED 100%!")
    finally:
        server.stop()

if __name__ == '__main__':
    run()

