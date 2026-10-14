"""Tests for the Streamlit dashboard. Run from the project root:

    python dashboard/test_app.py

The page tests use a fake API client, so neither the Node server nor Docker needs to be running.
"""

import datetime as dt
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from streamlit.testing.v1 import AppTest  # noqa: E402

import api  # noqa: E402
from api import ApiError  # noqa: E402

APP = str(HERE / "app.py")

PLANS = [
    {"id": "free", "rate_limit_per_min": 100, "max_active_keys": 3},
    {"id": "pro", "rate_limit_per_min": 1000, "max_active_keys": 10},
]
LIMITS = {"free": 100, "pro": 1000}

today = dt.datetime.now(dt.timezone.utc).date().isoformat()
now_iso = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def make_key(key_id, name, revoked=False):
    return {
        "id": key_id, "name": name, "key_prefix": f"ak_live_{key_id}",
        "permissions": ["models", "chat"], "rate_limit_per_min": 1000,
        "created_at": now_iso, "expires_at": None,
        "revoked_at": now_iso if revoked else None,
    }


KEYS = [make_key("k1", "production backend"), make_key("k2", "old key", revoked=True)]

LOGS = [
    {"created_at": now_iso, "key_id": "k1", "key_name": "production backend", "method": "POST",
     "endpoint": "/v1/chat/completions", "status_code": 200, "latency_ms": 312.456, "tokens": 27},
    {"created_at": now_iso, "key_id": "k1", "key_name": "production backend", "method": "GET",
     "endpoint": "/v1/embeddings", "status_code": 403, "latency_ms": 2.1, "tokens": 0},
]

passed = 0
failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print("PASS ", name)
    else:
        failed += 1
        print("FAIL ", name, detail)


def usage_payload(requests=28, errors=3):
    daily = []
    if requests:
        daily = [{"day": today, "requests": requests, "errors": errors,
                  "error_rate": round(errors / requests, 4), "avg_latency_ms": 240.4, "tokens": 540}]
    return {
        "key_id": None,
        "today": requests, "this_month": requests, "all_time": requests,
        "tokens": {"today": 540 if requests else 0, "this_month": 540 if requests else 0,
                   "all_time": 540 if requests else 0},
        "range": {"from": today, "to": today, "requests": requests, "errors": errors,
                  "error_rate": round(errors / requests, 4) if requests else 0,
                  "avg_latency_ms": 240.4 if requests else 0, "tokens": 540 if requests else 0},
        "daily": daily,
        "by_key": [{"id": "k1", "name": "production backend", "key_prefix": "ak_live_k1",
                    "requests": requests, "errors": errors, "tokens": 540 if requests else 0}]
        if requests else [],
    }


class FakeClient:
    def __init__(self, plan="pro", keys=None, **over):
        self.plan = plan
        self.keys = KEYS if keys is None else keys
        self.over = over
        self.created = []
        self.revoked = []
        self.plan_changes = []

    def user(self):
        return {"id": "u1", "email": "meera@example.com", "plan": self.plan,
                "rate_limit_per_min": LIMITS[self.plan]}

    def me(self):
        if "me_error" in self.over:
            raise self.over["me_error"]
        return self.user()

    def plans(self):
        if "plans_error" in self.over:
            raise self.over["plans_error"]
        return PLANS

    def change_plan(self, plan):
        if "change_error" in self.over:
            raise self.over["change_error"]
        self.plan_changes.append(plan)
        self.plan = plan
        return {"plan": plan, "rate_limit_per_min": LIMITS[plan], "changed": True, "keys_updated": 2}

    def list_keys(self):
        if "keys_error" in self.over:
            raise self.over["keys_error"]
        return self.keys

    def usage(self, date_from, date_to, key_id=None):
        if "usage_error" in self.over:
            raise self.over["usage_error"]
        return usage_payload(**self.over.get("usage", {}))

    def logs(self, key_id=None, limit=50):
        return LOGS

    def create_key(self, name, permissions, expires_at=None):
        self.created.append((name, permissions, expires_at))
        return {"key": "ak_live_TESTKEY123", "name": name}

    def revoke_key(self, key_id):
        self.revoked.append(key_id)
        return {"revoked": True}

    def logout(self):
        return {"loggedOut": True}

    def login(self, email, password):
        if password != "right":
            raise ApiError(401, "invalid_credentials")
        return self.user()

    def signup(self, email, password):
        raise ApiError(409, "email_taken")


def new_app(client, logged_in=True):
    at = AppTest.from_file(APP, default_timeout=30)
    at.session_state["client"] = client
    at.session_state["user"] = client.user() if logged_in else None
    at.session_state["new_key"] = None
    at.session_state["flash"] = None
    at.session_state["notice"] = None
    return at


def go(at, page):
    at.run()
    at.sidebar.radio[0].set_value(page).run()
    return at


def button(at, label):
    found = [b for b in at.button if b.label == label]
    return found[0] if found else None


def text_input(at, label):
    return [t for t in at.text_input if t.label == label][0]


# ---------- login ----------

at = AppTest.from_file(APP, default_timeout=30)
at.run()
check("auth page renders without errors", not at.exception, at.exception)
check("auth page has the title", at.title and at.title[0].value == "DummyAI console")
check("auth page has two tabs", len(at.tabs) == 2)

at = new_app(FakeClient(), logged_in=False)
at.run()
text_input(at, "Email").input("a@b.co")
at.text_input(key="login_password").input("wrong")
at.button[0].click().run()
check("wrong password shows a friendly error",
      at.error and at.error[0].value == "Wrong email or password.", [e.value for e in at.error])
at.text_input(key="login_password").input("right")
at.button[0].click().run()
check("right password logs in and lands on Usage",
      at.session_state["user"] is not None and at.header and at.header[0].value == "Usage",
      [h.value for h in at.header])

# ---------- usage ----------

at = new_app(FakeClient())
at.run()
check("usage page renders without errors", not at.exception, at.exception)
values = [m.value for m in at.metric]
check("four summary cards with the right numbers", values == ["28", "540", "10.7%", "240 ms"], values)
subs = [s.value for s in at.subheader]
check("charts, per-key table and recent requests are shown",
      "Requests per day" in subs and "Tokens per day" in subs
      and "Usage by key" in subs and "Recent requests" in subs, subs)
check("usage page is the default page", at.sidebar.radio[0].value == "Usage")
check("sidebar lists all four pages",
      list(at.sidebar.radio[0].options) == ["Usage", "API keys", "Quickstart", "Plan"],
      list(at.sidebar.radio[0].options))

at = new_app(FakeClient(usage={"requests": 0, "errors": 0}))
at.run()
check("empty period renders without errors", not at.exception, at.exception)
infos = [i.value for i in at.info]
check("empty period shows the no-requests message",
      any("No requests in this period" in i for i in infos), infos)
check("empty period hides the charts", "Requests per day" not in [s.value for s in at.subheader])

at = new_app(FakeClient())
at.run()
at.selectbox[0].select("Custom").run()
check("custom period renders without errors", not at.exception, at.exception)

at = new_app(FakeClient(usage_error=ApiError(400, "range_too_large")))
at.run()
check("range_too_large shows a friendly message",
      at.error and at.error[0].value == "Pick a period of 366 days or less.", [e.value for e in at.error])

at = new_app(FakeClient(keys_error=ApiError(0, "server_unreachable")))
at.run()
check("API down shows a friendly message",
      at.error and "Can't reach the API" in at.error[0].value, [e.value for e in at.error])

at = new_app(FakeClient(me_error=ApiError(401, "session_invalid")))
at.run()
check("ended session goes back to login with a notice",
      at.session_state["user"] is None and at.info
      and at.info[0].value == "Your session ended. Log in again.", [i.value for i in at.info])

# ---------- API keys ----------

client = FakeClient()
at = go(new_app(client), "API keys")
check("keys page renders without errors", not at.exception, at.exception)
check("keys page header", at.header and at.header[0].value == "API keys")
revokes = [b for b in at.button if b.label == "Revoke"]
check("only active keys have a Revoke button", len(revokes) == 1, len(revokes))

text_input(at, "Name").input("my new key")
button(at, "Create key").click().run()
check("create key calls the API with the right values",
      client.created and client.created[0][0] == "my new key" and client.created[0][1] == ["chat"],
      client.created)
check("new key is shown once",
      at.success and at.success[0].value.startswith("Key created")
      and any("ak_live_TESTKEY123" in c.value for c in at.code),
      [s.value for s in at.success])
at.run()
check("new key disappears on the next run", len(at.success) == 0)
button(at, "Revoke").click().run()
check("revoke calls the API for the right key", client.revoked == ["k1"], client.revoked)

# ---------- quickstart ----------

at = go(new_app(FakeClient()), "Quickstart")
check("quickstart renders without errors", not at.exception, at.exception)
check("quickstart header", at.header and at.header[0].value == "Quickstart")
check("quickstart has four language tabs", len(at.tabs) == 4, len(at.tabs))
codes = [c.value for c in at.code]
check("every example uses the placeholder key and the API address",
      len(codes) == 4 and all("YOUR_API_KEY" in c and "http://localhost:3000" in c for c in codes),
      codes)

real_try_chat = api.try_chat
seen = {}


def fake_ok(key, model, message):
    seen.update(key=key, model=model, message=message)
    return {"status": 200, "headers": {"X-RateLimit-Limit": "1000"}, "body": {"ok": True},
            "elapsed_ms": 123}


def fake_forbidden(key, model, message):
    return {"status": 403, "headers": {}, "body": {"error": "scope_forbidden"}, "elapsed_ms": 5}


def fake_down(key, model, message):
    raise ApiError(0, "server_unreachable")


api.try_chat = fake_ok
at = go(new_app(FakeClient()), "Quickstart")
text_input(at, "API key").input("  ak_live_abc  ")
button(at, "Send request").click().run()
check("try it shows the status and timing",
      at.success and at.success[-1].value == "HTTP 200 in 123 ms", [s.value for s in at.success])
check("try it shows the response body and rate limit header", len(at.json) == 1
      and any("X-RateLimit-Limit: 1000" in c.value for c in at.caption))
check("try it trims the key and sends the chosen model",
      seen.get("key") == "ak_live_abc" and seen.get("model") == "dummy-small", seen)

api.try_chat = fake_forbidden
at = go(new_app(FakeClient()), "Quickstart")
text_input(at, "API key").input("ak_live_abc")
button(at, "Send request").click().run()
check("try it shows a failed request as an error",
      at.error and at.error[0].value == "HTTP 403 in 5 ms", [e.value for e in at.error])

api.try_chat = fake_down
at = go(new_app(FakeClient()), "Quickstart")
text_input(at, "API key").input("ak_live_abc")
button(at, "Send request").click().run()
check("try it shows a friendly message when the API is down",
      at.error and "Can't reach the API" in at.error[0].value, [e.value for e in at.error])
api.try_chat = real_try_chat

at = go(new_app(FakeClient()), "Quickstart")
button(at, "Send request").click().run()
check("try it asks for a key when the field is empty",
      at.error and at.error[0].value == "Paste an API key first.", [e.value for e in at.error])

# ---------- plan ----------

client = FakeClient(plan="pro")
at = go(new_app(client), "Plan")
check("plan page renders without errors", not at.exception, at.exception)
check("plan page shows both plans", [s.value for s in at.subheader] == ["Free", "Pro"],
      [s.value for s in at.subheader])
check("current plan is marked", sum(1 for m in at.markdown if m.value == "Your current plan") == 1)
check("downgrade is blocked until confirmed", button(at, "Switch to Free").disabled is True)
at.checkbox[0].check().run()
check("confirming enables the downgrade button", button(at, "Switch to Free").disabled is False)
button(at, "Switch to Free").click().run()
check("downgrade calls the API", client.plan_changes == ["free"], client.plan_changes)
check("downgrade shows a confirmation",
      at.success and "You're now on the Free plan" in at.success[0].value
      and "100 requests per minute" in at.success[0].value, [s.value for s in at.success])
check("the page now offers an upgrade", button(at, "Upgrade to Pro") is not None)

client = FakeClient(plan="free")
at = go(new_app(client), "Plan")
button(at, "Upgrade to Pro").click().run()
check("upgrade calls the API and confirms",
      client.plan_changes == ["pro"] and at.success
      and "Pro plan" in at.success[0].value and "1,000" in at.success[0].value,
      (client.plan_changes, [s.value for s in at.success]))

many = [make_key(f"k{i}", f"key {i}") for i in range(4)]
at = go(new_app(FakeClient(plan="pro", keys=many)), "Plan")
check("too many active keys blocks the downgrade",
      at.warning and "You have 4 active keys" in at.warning[0].value
      and "Revoke 1 first" in at.warning[0].value
      and at.checkbox[0].disabled is True and button(at, "Switch to Free").disabled is True,
      [w.value for w in at.warning])

client = FakeClient(plan="pro",
                    change_error=ApiError(409, "revoke_keys_first", "the free plan allows 3 active keys; you have 5"))
at = go(new_app(client), "Plan")
at.checkbox[0].check().run()
button(at, "Switch to Free").click().run()
check("the API's own downgrade message is shown",
      at.error and at.error[0].value == "the free plan allows 3 active keys; you have 5",
      [e.value for e in at.error])

at = go(new_app(FakeClient(plans_error=ApiError(0, "server_unreachable"))), "Plan")
check("plan page shows a friendly message when the API is down",
      at.error and "Can't reach the API" in at.error[0].value, [e.value for e in at.error])

# ---------- the API client over real HTTP ----------


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_json(self, status, obj, headers=None):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/api/plans":
            return self.send_json(200, PLANS)
        self.send_json(404, {"error": "not_found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path == "/api/plan":
            if body.get("plan") not in LIMITS:
                return self.send_json(400, {"error": "invalid_plan", "message": "plan must be free or pro"})
            return self.send_json(200, {"plan": body["plan"], "rate_limit_per_min": LIMITS[body["plan"]],
                                        "changed": True, "keys_updated": 2})
        if self.path == "/v1/chat/completions":
            if self.headers.get("Authorization") != "Bearer ak_live_good":
                return self.send_json(401, {"error": "invalid_key"})
            return self.send_json(200, {"object": "chat.completion"},
                                  {"X-RateLimit-Limit": "1000", "X-RateLimit-Remaining": "999",
                                   "X-Unrelated": "x"})
        self.send_json(404, {"error": "not_found"})


server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
original_base = api.BASE_URL
api.BASE_URL = f"http://127.0.0.1:{server.server_port}"

client = api.ApiClient()
check("client.plans returns the plan list", client.plans() == PLANS)
check("client.change_plan returns the new plan", client.change_plan("pro")["plan"] == "pro")
try:
    client.change_plan("gold")
    check("client.change_plan rejects unknown plans", False, "no error raised")
except ApiError as err:
    check("client.change_plan rejects unknown plans",
          err.status == 400 and err.code == "invalid_plan" and err.message == "plan must be free or pro",
          (err.status, err.code, err.message))

result = api.try_chat("ak_live_good", "dummy-small", "hi")
check("try_chat returns status, body and timing",
      result["status"] == 200 and result["body"] == {"object": "chat.completion"}
      and isinstance(result["elapsed_ms"], int), result)
check("try_chat keeps only rate limit headers",
      result["headers"] == {"X-RateLimit-Limit": "1000", "X-RateLimit-Remaining": "999"}, result["headers"])
check("try_chat returns a wrong key as a 401 result, not a crash",
      api.try_chat("ak_live_bad", "dummy-small", "hi")["status"] == 401)

server.shutdown()
api.BASE_URL = "http://127.0.0.1:9"
try:
    api.try_chat("ak_live_good", "dummy-small", "hi")
    check("try_chat reports an unreachable server", False, "no error raised")
except ApiError as err:
    check("try_chat reports an unreachable server", err.code == "server_unreachable", err.code)
api.BASE_URL = original_base

print()
print(f"{passed} passed, {failed} failed")
sys.exit(0 if failed == 0 else 1)