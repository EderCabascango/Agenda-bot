import sys
import time
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
    print("Testing Point 6: Local icons & offline network isolation...")
    proc = ensure_server()
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()
            
            # Intercept and ABORT all non-local external internet requests (e.g. CDN, googleapis)
            aborted_urls = []
            def handle_route(route):
                url = route.request.url
                if "127.0.0.1" in url or "localhost" in url:
                    route.continue_()
                else:
                    aborted_urls.append(url)
                    route.abort()
            
            page.route("**", handle_route)
            
            # Load app
            page.goto('http://127.0.0.1:8000/?e2e=1')
            page.wait_for_selector('.nav-item .material-icons-round', state='visible')
            
            # Verify icons count
            icons_count = page.locator('.material-icons-round').count()
            print(f"Icons rendered with external network disabled: {icons_count}")
            print(f"Aborted external network requests: {len(aborted_urls)}")
            
            assert icons_count > 0, "Expected material-icons-round elements to be rendered locally"
            assert len(aborted_urls) == 0, f"Expected 0 external network requests, found {len(aborted_urls)} ({aborted_urls})"
            
            # Verify no CDN font links in head
            cdn_links = page.locator('link[href*="googleapis.com"]').count()
            print(f"Google Fonts CDN links count: {cdn_links}")
            assert cdn_links == 0, f"Expected 0 Google Fonts CDN links, found {cdn_links}"
            
            # Verify local font CSS link
            local_css = page.locator('link[href*="material-icons-round.css"]').count()
            assert local_css == 1, "Expected 1 local material-icons-round.css link"
            
            browser.close()
            print("Point 6 verification PASSED 100%!")
    finally:
        if proc:
            proc.terminate()

if __name__ == '__main__':
    run()
