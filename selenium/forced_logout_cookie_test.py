"""
Single test case: when the API answers 401, manager-front sets the `is_forced_logout` cookie
(plugins/axios.ts for SSR, utils/httpClient/response.ts for ofetch) and redirects to /login.

Flow: log in, corrupt access_token/id_token (keeping refresh/user/role so the session still counts as
logged in), load a page whose SSR makes an API call, then check on /login that the cookie is "true".
login.vue resets the cookie in onMounted right after its alert, so window.alert is replaced to record
document.cookie when it fires (a real alert would block every WebDriver/CDP command).

Usage (same .env as login_session_test.py):
    python selenium/forced_logout_cookie_test.py

Env vars: FORCED_LOGOUT_PATH  page that calls the API on load (default /settings/shops/board)
"""

import os
import sys

from selenium.webdriver.support.ui import WebDriverWait

from login_session_test import BASE_URL, login_instance

PATH = os.environ.get("FORCED_LOGOUT_PATH", "/settings/shops/board")
ALERT_TEXT = "認証に失敗しました。"  # login.vue shows this only when is_forced_logout is truthy


RECORD_ALERT = """
window.alert = function(message) {
  window.__alert = { message: message, cookie: document.cookie };
};
"""

def run_test() -> bool:
    drivers: dict = {}
    try:
        if not login_instance("forced-logout", drivers):
            print("FAIL - could not log in")
            return False
        driver = drivers["forced-logout"]

        for name in ("access_token", "id_token"):
            driver.add_cookie({"name": name, "value": "invalid-token", "path": "/", "secure": True})
        driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": RECORD_ALERT})

        driver.get(f"{BASE_URL}{PATH}")
        try:
            alert = WebDriverWait(driver, 20).until(lambda d: d.execute_script("return window.__alert || null"))
        except Exception:
            print(f"FAIL - no forced-logout alert after loading {PATH} (url: {driver.current_url})")
            return False

        cookies = dict(c.strip().partition("=")[::2] for c in alert["cookie"].split(";"))
        if cookies.get("is_forced_logout") != "true":
            print(f"FAIL - is_forced_logout={cookies.get('is_forced_logout')!r}, expected 'true'")
            return False
        if alert["message"] != ALERT_TEXT:
            print(f"FAIL - alert text {alert['message']!r}, expected {ALERT_TEXT!r}")
            return False
        print("PASS - is_forced_logout was set to 'true' after a 401")
        return True
    finally:
        for driver in drivers.values():
            driver.quit()


if __name__ == "__main__":
    sys.exit(0 if run_test() else 1)
