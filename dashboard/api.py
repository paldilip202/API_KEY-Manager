import os
import time

import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:3000")


class ApiError(Exception):
    def __init__(self, status, code, message=""):
        super().__init__(message or code)
        self.status = status
        self.code = code
        self.message = message


class ApiClient:
    """One instance per browser tab. It keeps the session cookie for that user."""

    def __init__(self):
        self.http = requests.Session()

    def _request(self, method, path, **kwargs):
        try:
            res = self.http.request(method, BASE_URL + path, timeout=10, **kwargs)
        except requests.RequestException:
            raise ApiError(0, "server_unreachable", f"Can't reach the API at {BASE_URL}.")
        try:
            data = res.json()
        except ValueError:
            data = {}
        if res.status_code >= 400:
            raise ApiError(res.status_code, data.get("error", "error"), data.get("message", ""))
        return data

    def signup(self, email, password):
        return self._request("POST", "/api/signup", json={"email": email, "password": password})

    def login(self, email, password):
        return self._request("POST", "/api/login", json={"email": email, "password": password})

    def logout(self):
        return self._request("POST", "/api/logout")

    def me(self):
        return self._request("GET", "/api/me")

    def plans(self):
        return self._request("GET", "/api/plans")

    def change_plan(self, plan):
        return self._request("POST", "/api/plan", json={"plan": plan})

    def list_keys(self):
        return self._request("GET", "/api/keys")

    def create_key(self, name, permissions, expires_at=None):
        body = {"name": name, "permissions": permissions}
        if expires_at:
            body["expiresAt"] = expires_at
        return self._request("POST", "/api/keys", json=body)

    def revoke_key(self, key_id):
        return self._request("DELETE", f"/api/keys/{key_id}")

    def usage(self, date_from, date_to, key_id=None):
        params = {"from": date_from, "to": date_to}
        if key_id:
            params["key_id"] = key_id
        return self._request("GET", "/api/usage", params=params)

    def logs(self, key_id=None, limit=50):
        params = {"limit": limit}
        if key_id:
            params["key_id"] = key_id
        return self._request("GET", "/api/logs", params=params)


def try_chat(key, model, message):
    """Call the public service the way a customer's app would: with only an API key.

    This deliberately does not use the dashboard login session.
    """
    started = time.perf_counter()
    try:
        res = requests.post(
            BASE_URL + "/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json={"model": model, "messages": [{"role": "user", "content": message}]},
            timeout=15,
        )
    except requests.RequestException:
        raise ApiError(0, "server_unreachable", f"Can't reach the API at {BASE_URL}.")
    elapsed_ms = round((time.perf_counter() - started) * 1000)

    try:
        body = res.json()
    except ValueError:
        body = {}

    wanted = ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After"]
    headers = {name: res.headers[name] for name in wanted if name in res.headers}
    return {"status": res.status_code, "headers": headers, "body": body, "elapsed_ms": elapsed_ms}