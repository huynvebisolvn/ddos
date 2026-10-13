"""
Run NUM_INSTANCES headless Chrome sessions, each logging in independently (its own
Cognito session - no shared/racing refresh_token). Each instance then tears off
TABS_PER_INSTANCE separate windows (sharing that instance's login session), tiles them
into their own spot on screen, and injects a JS spam-loop (via CDP
Page.addScriptToEvaluateOnNewDocument) into each tab so it keeps jumping to a random
path from TARGET_PATHS on its own, fully in-browser - this runs truly concurrently
across every tab/instance since it no longer depends on Selenium's single-threaded,
one-command-at-a-time session to drive each jump.

Usage:
    MANAGER_FRONT_PASSWORD='...' python3 scripts/selenium/login_session_test.py

Env vars:
    TARGET_URL                base URL of manager-front (default http://localhost:3000)
    MANAGER_FRONT_EMAIL        login email (default huynvebisolvn@gmail.com)
    MANAGER_FRONT_PASSWORD     login password
    TARGET_PATHS               comma-separated paths to randomly pick from (default: every clickable
                               link of the manager-front menu, from src/composables/useMenu.ts)
    NUM_INSTANCES              number of independent login sessions to run (default 2)
    TABS_PER_INSTANCE          number of windows torn off per instance (default 5)
    SPAM_INTERVAL_MS           delay in ms between jumps, timed by the browser itself (default 300)
    TEST_DURATION_SECONDS   total seconds to keep spamming (default 60)
    WINDOW_WIDTH, WINDOW_HEIGHT, GRID_COLUMNS   grid layout of the browser windows
"""

import json
import os
import random
import sys
import threading
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

# .env next to this script (git-ignored); already-set environment variables win
env_file = Path(__file__).with_name(".env")
if env_file.is_file():
    for line in env_file.read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep and not line.lstrip().startswith("#"):
            os.environ.setdefault(key.strip(), value.strip().strip("\"'"))

BASE_URL = os.environ.get("TARGET_URL")
EMAIL = os.environ.get("MANAGER_FRONT_EMAIL")
PASSWORD = os.environ.get("MANAGER_FRONT_PASSWORD")
TARGET_PATHS = os.environ.get(
    "TARGET_PATHS",
    ",".join(
        [
            # インフォメーション
            "/settings/shops/board",
            "/informations/notification",
            "/informations/organizes/notifications",
            "/informations/system-notifications",
            # 予約管理
            "/reservation/search",
            "/reservation/mgr/report-options",
            "/reservation/op/report-options",
            # お客様管理
            "/customers/unification/search",
            "/customers/create",
            "/customers/search",
            "/customers/import",
            # 設定 > 予約台帳設定
            "/settings/shops/tables",
            "/settings/shops/tabs",
            "/settings/shops/table-types",
            "/settings/shops/tables/layout",
            "/settings/shops/table-patterns",
            "/settings/shops/opening-hours",
            "/settings/shops/courses",
            "/settings/shops/staff-members",
            "/settings/shops/reservation-codes",
            "/settings/shops/inflows",
            "/settings/shops/emails/deliveries",
            "/settings/shops/emails/accept-reservations",
            "/settings/shops/emails/remind-reservations",
            "/settings/shops/emails/change-reservations/to-customers",
            "/settings/shops/emails/cancel-reservations/to-customers",
            "/settings/shops/sms/today-reminders",
            "/settings/shops/emails/accept-reservations/to-shop",
            "/settings/shops/emails/change-reservations/to-shop",
            "/settings/shops/emails/cancel-reservations/to-shop",
            # 設定 > ネット予約設定
            "/settings/shops/web-reservations/basic",
            "/settings/shops/web-reservations/smart",
            "/settings/shops/web-reservations/smart/vacant",
            "/settings/shops/web-reservations/smart/plan",
            "/settings/shops/plans",
            "/settings/shops/web-reservations/url",
            "/settings/shops/web-reservations/pages/display-items/input-form",
            "/settings/shops/web-reservations/pages/display-items/reservation-confirmation-page",
            "/settings/shops/web-reservations/pages/display-items/completion-page",
            "/settings/shops/web-reservations/pages/display-items/select-cancel-or-change",
            "/settings/shops/web-reservations/pages/display-items/change-reservation",
            "/settings/shops/web-reservations/pages/display-items/change-confirmation-page",
            "/settings/shops/web-reservations/pages/display-items/change-completion-page",
            "/settings/shops/web-reservations/pages/display-items/cancellation-completion-page",
            # 設定 > その他設定
            "/settings/shops/informations",
            "/settings/shops/recommend-shops",
            "/settings/shops/sales-totals",
            # 設定 > 詳細設定
            "/settings/shops/web-reservations/statuses",
            "/settings/shops/calendar-minimum-unit",
            "/settings/shops/daychange-hour",
            "/settings/shops/register-items/reservations",
            "/settings/shops/web-reservation-codes",
            "/settings/shops/web-reservations/additional-questions/1/ja",
            "/settings/shops/web-reservations/additional-questions/2/ja",
            "/settings/shops/web-reservations/additional-questions/3/ja",
            "/settings/shops/web-reservations/additional-questions/4/ja",
            "/settings/shops/web-reservations/additional-questions/5/ja",
            "/settings/shops/register-items/customers",
            "/settings/sites/customer-codes",
            "/settings/sites/anniversaries",
            "/settings/sites/member-codes",
            # 設定 > インポート/エクスポート/初期設定
            "/settings/shops/import",
            "/settings/shops/export",
            "/settings/shops/initial-setup",
            "/masters/organizes/initial-setup/shop",
            "/masters/support-groups/initial-setup/shop",
            "/initial-setup/shop/masters",
            # 管理者機能
            "/system/users/general-users",
            "/system/users/shared-users",
            "/shop-groups",
            "/system/bulk-settings/opening-hours",
            "/system/bulk-settings/courses",
            # 契約・請求管理
            "/histories/sms-fax-billings",
            "/histories/sms-sent",
            "/histories/fax-sent",
            # ショートカット
            "/",
        ]
    ),
).split(",")
TEST_DURATION_SECONDS = int(os.environ.get("TEST_DURATION_SECONDS"))
LOGIN_MAX_ATTEMPTS = int(os.environ.get("LOGIN_MAX_ATTEMPTS", "20"))
LOGIN_WAIT_SECONDS = int(os.environ.get("LOGIN_WAIT_SECONDS", "8"))
NUM_INSTANCES = int(os.environ.get("NUM_INSTANCES"))
TABS_PER_INSTANCE = int(os.environ.get("TABS_PER_INSTANCE"))
SPAM_INTERVAL_MS = int(os.environ.get("SPAM_INTERVAL_MS", "300"))
WINDOW_WIDTH = int(os.environ.get("WINDOW_WIDTH", "50"))
WINDOW_HEIGHT = int(os.environ.get("WINDOW_HEIGHT", "50"))
GRID_COLUMNS = int(os.environ.get("GRID_COLUMNS", "5"))

EMAIL_XPATH = '//*[@id="__nuxt"]/div/section/div/div[2]/div[2]/form/div[1]/div/input'
PASSWORD_XPATH = '//*[@id="__nuxt"]/div/section/div/div[2]/div[2]/form/div[2]/div/input'
LOGIN_BUTTON_XPATH = '//*[@id="__nuxt"]/div/section/div/div[2]/div[2]/form/div[3]/button'

# ponytail: reload-based navigation also re-triggers this script on the /login page if a
# session ever expires mid-spam; it'll just keep bouncing off /login rather than re-authing -
# acceptable for a load/leak test, restart the run if that happens.
SPAM_SCRIPT = """
(function() {
  var paths = %s;
  var baseUrl = %s;
  var intervalMs = %s;
  setTimeout(function() {
    var path = paths[Math.floor(Math.random() * paths.length)];
    if (location.pathname === path) {
      location.reload();
    } else {
      location.href = baseUrl + path;
    }
  }, intervalMs);
})();
""" % (json.dumps(TARGET_PATHS), json.dumps(BASE_URL), SPAM_INTERVAL_MS)


def new_chrome_options() -> webdriver.ChromeOptions:
    options = webdriver.ChromeOptions()
    # "none": driver.get() returns as soon as navigation starts instead of blocking until the
    # page finishes loading - tab setup just needs to fire the navigation, not wait on it
    options.page_load_strategy = "none"
    # suppress "Change your password" breach-detection popup and save-password bubble
    options.add_experimental_option(
        "prefs",
        {
            "credentials_enable_service": False,
            "profile.password_manager_enabled": False,
            "profile.password_manager_leak_detection": False,
        },
    )
    return options


def position_window(driver: webdriver.Chrome, index: int) -> None:
    # Chrome enforces its own minimum window size, so a small requested size gets
    # clamped; read back the real size so tiles are spaced correctly and don't overlap.
    driver.set_window_size(WINDOW_WIDTH, WINDOW_HEIGHT)
    size = driver.get_window_size()
    col = index % GRID_COLUMNS
    row = index // GRID_COLUMNS
    driver.set_window_position(col * size["width"], row * size["height"])


class PositionCounter:
    """Thread-safe counter so windows opened by different instances don't overlap on screen."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._value = 0

    def next(self) -> int:
        with self._lock:
            value = self._value
            self._value += 1
            return value


def attempt_login(driver: webdriver.Chrome) -> bool:
    driver.get(f"{BASE_URL}/login")
    time.sleep(2)
    try:
        WebDriverWait(driver, LOGIN_WAIT_SECONDS).until(
            EC.presence_of_element_located((By.XPATH, EMAIL_XPATH))
        ).send_keys(EMAIL)
        driver.find_element(By.XPATH, PASSWORD_XPATH).send_keys(PASSWORD)
        login_button = WebDriverWait(driver, LOGIN_WAIT_SECONDS).until(
            EC.element_to_be_clickable((By.XPATH, LOGIN_BUTTON_XPATH))
        )
        # click via JS: the native click can get intercepted by the Nuxt DevTools overlay
        driver.execute_script("arguments[0].click();", login_button)
        WebDriverWait(driver, LOGIN_WAIT_SECONDS).until(lambda d: "/login" not in d.current_url)
        return True
    except Exception:
        return False


def login_instance(label: str, drivers: dict) -> bool:
    driver = webdriver.Chrome(options=new_chrome_options())
    drivers[label] = driver

    logged_in = False
    for attempt in range(1, LOGIN_MAX_ATTEMPTS + 1):
        if attempt_login(driver):
            logged_in = True
            break
        print(f"[{label}] LOGIN FAILED (attempt {attempt}/{LOGIN_MAX_ATTEMPTS}) - still on {driver.current_url}")

    if not logged_in:
        return False

    # the toolbar auto-selects a default shop (select_shop_id cookie) and fetches its
    # feature-flag settings (options cookie) asynchronously after the first authenticated
    # page loads; settings pages need both, otherwise they bounce back to "/".
    try:
        WebDriverWait(driver, 15).until(
            lambda d: d.get_cookie("select_shop_id") is not None and d.get_cookie("options") is not None
        )
    except Exception:
        print(f"[{label}] FAILED - select_shop_id/options were never set after login")
        return False

    print(f"[{label}] logged in")
    return True


def open_tabs(label: str, driver: webdriver.Chrome, position_counter: PositionCounter) -> None:
    # tear off TABS_PER_INSTANCE separate windows sharing this instance's login session,
    # each tiled into its own spot on screen instead of staying stacked as plain tabs
    handles = [driver.current_window_handle]
    for _ in range(TABS_PER_INSTANCE - 1):
        driver.switch_to.new_window("window")
        handles.append(driver.current_window_handle)

    for tab_index, handle in enumerate(handles):
        driver.switch_to.window(handle)
        position_window(driver, position_counter.next())
        tab_label = f"{label}-tab{tab_index + 1}"
        try:
            # registered per-tab so it re-fires on every future navigation/reload in that tab,
            # letting the browser itself keep spamming with no further Selenium commands needed
            driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": SPAM_SCRIPT})
        except Exception as exc:
            print(f"[{tab_label}] WARN - could not inject spam script ({exc})")
        try:
            driver.get(f"{BASE_URL}{random.choice(TARGET_PATHS)}")
            print(f"[{tab_label}] navigation fired, spamming every {SPAM_INTERVAL_MS}ms")
        except Exception as exc:
            # page_load_strategy=none means get() returns almost immediately, so a failure here
            # is a real error (not a slow load) - log it and move on, don't abort the other tabs
            print(f"[{tab_label}] NAV FAILED ({exc}) - continuing to next tab")


def run_test() -> None:
    if not PASSWORD:
        sys.exit("MANAGER_FRONT_PASSWORD env var is required")

    drivers: dict = {}
    login_results: dict = {}
    position_counter = PositionCounter()

    def run_parallel(targets: list) -> None:
        threads = [threading.Thread(target=fn, args=args) for fn, args in targets]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

    try:
        # phase 1: log instances in one after another, each only starts once the previous is logged in
        labels = [f"instance-{i + 1}" for i in range(NUM_INSTANCES)]
        for label in labels:
            login_results[label] = login_instance(label, drivers)
            if not login_results[label]:
                break
        if not all(login_results.get(label) for label in labels):
            print("Not every instance logged in - aborting.")
            return

        # phase 2: open the tabs; each one then spams random paths in-browser, independent of the others
        run_parallel([(open_tabs, (label, drivers[label], position_counter)) for label in labels])

        print(f"All tabs are spamming in-browser for {TEST_DURATION_SECONDS}s (Ctrl+C to stop)...")
        time.sleep(TEST_DURATION_SECONDS)
    except KeyboardInterrupt:
        pass
    finally:
        for driver in drivers.values():
            driver.quit()


if __name__ == "__main__":
    run_test()
