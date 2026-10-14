import datetime as dt

import pandas as pd
import streamlit as st

from api import BASE_URL, ApiClient, ApiError, try_chat

st.set_page_config(page_title="DummyAI console", layout="wide")

MESSAGES = {
    "invalid_credentials": "Wrong email or password.",
    "email_taken": "That email already has an account. Log in instead.",
    "invalid_email": "Enter a valid email address.",
    "password_too_short": "Use at least 8 characters for your password.",
    "invalid_name": "Enter a name for the key (60 characters at most).",
    "invalid_permissions": "Choose at least one permission.",
    "key_limit_reached": "You've reached your plan's limit of active keys. Revoke one first.",
    "server_unreachable": "Can't reach the API. Check that the server is running.",
    "invalid_date_range": "Choose a start date that's before the end date.",
    "range_too_large": "Pick a period of 366 days or less.",
    "not_found": "We couldn't find that. Try refreshing the page.",
    "invalid_plan": "That plan doesn't exist.",
}


def friendly(err):
    return MESSAGES.get(err.code) or err.message or "Something went wrong. Try again."


def reset_session(flash=None):
    st.session_state.client = ApiClient()
    st.session_state.user = None
    st.session_state.new_key = None
    st.session_state.flash = flash
    st.session_state.notice = None


if "client" not in st.session_state:
    reset_session()


def call(fn, *args, **kwargs):
    """Run an API call. If the login session has ended, go back to the login screen."""
    try:
        return fn(*args, **kwargs)
    except ApiError as err:
        if err.code in ("login_required", "session_invalid"):
            reset_session("Your session ended. Log in again.")
            st.rerun()
        raise


def show_auth():
    client = st.session_state.client
    st.title("DummyAI console")
    st.caption("Create API keys for the DummyAI API and keep an eye on your usage.")

    flash = st.session_state.get("flash")
    if flash:
        st.info(flash)
        st.session_state.flash = None

    login_tab, signup_tab = st.tabs(["Log in", "Sign up"])

    with login_tab:
        with st.form("login_form"):
            email = st.text_input("Email", key="login_email")
            password = st.text_input("Password", type="password", key="login_password")
            submitted = st.form_submit_button("Log in")
        if submitted:
            try:
                st.session_state.user = client.login(email, password)
                st.rerun()
            except ApiError as err:
                st.error(friendly(err))

    with signup_tab:
        with st.form("signup_form"):
            email = st.text_input("Email", key="signup_email")
            password = st.text_input("Password", type="password", key="signup_password")
            submitted = st.form_submit_button("Create account")
        if submitted:
            try:
                st.session_state.user = client.signup(email, password)
                st.rerun()
            except ApiError as err:
                st.error(friendly(err))


def parse_time(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def key_status(key):
    if key["revoked_at"]:
        return "Revoked"
    if key["expires_at"] and parse_time(key["expires_at"]) < dt.datetime.now(dt.timezone.utc):
        return "Expired"
    return "Active"


def show_keys():
    client = st.session_state.client
    user = st.session_state.user

    st.header("API keys")
    st.write(
        f"Plan: {user['plan'].title()}. "
        f"Each key can make {user['rate_limit_per_min']} requests per minute."
    )

    new_key = st.session_state.get("new_key")
    if new_key:
        st.success("Key created. Copy it now. You won't be able to see it again.")
        st.code(new_key, language=None)
        st.session_state.new_key = None

    with st.expander("Create a new key"):
        with st.form("create_key_form", clear_on_submit=True):
            name = st.text_input("Name", placeholder="production backend")
            permissions = st.multiselect("Permissions", ["models", "chat"], default=["chat"])
            expiry = st.selectbox("Expires", ["Never", "7 days", "30 days", "90 days"])
            create = st.form_submit_button("Create key")
        if create:
            days = {"Never": None, "7 days": 7, "30 days": 30, "90 days": 90}[expiry]
            expires_at = None
            if days:
                when = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=days)
                expires_at = when.strftime("%Y-%m-%dT%H:%M:%SZ")
            try:
                created = call(client.create_key, name, permissions, expires_at)
                st.session_state.new_key = created["key"]
                st.rerun()
            except ApiError as err:
                st.error(friendly(err))

    try:
        keys = call(client.list_keys)
    except ApiError as err:
        st.error(friendly(err))
        return

    if not keys:
        st.info("No keys yet. Create your first one above.")
        return

    widths = [2, 2, 2, 1.5, 2, 1]
    for col, text in zip(st.columns(widths), ["Name", "Key", "Permissions", "Status", "Expires", ""]):
        col.markdown(f"**{text}**")

    for key in keys:
        status = key_status(key)
        cols = st.columns(widths)
        cols[0].write(key["name"])
        cols[1].code(key["key_prefix"] + "...", language=None)
        cols[2].write(", ".join(key["permissions"]) or "none")
        cols[3].write(status)
        cols[4].write(key["expires_at"][:10] if key["expires_at"] else "Never")
        if status == "Active" and cols[5].button("Revoke", key=f"revoke_{key['id']}"):
            try:
                call(client.revoke_key, key["id"])
                st.rerun()
            except ApiError as err:
                st.error(friendly(err))

    st.caption("Revoking a key stops it working right away and can't be undone.")


def pick_range():
    today = dt.datetime.now(dt.timezone.utc).date()
    choice = st.selectbox("Period (UTC days)", ["Last 7 days", "Last 30 days", "Custom"])
    if choice == "Last 7 days":
        return today - dt.timedelta(days=6), today
    if choice == "Last 30 days":
        return today - dt.timedelta(days=29), today
    picked = st.date_input(
        "Dates",
        value=(today - dt.timedelta(days=6), today),
        max_value=today,
    )
    if isinstance(picked, (tuple, list)) and len(picked) == 2:
        return picked[0], picked[1]
    return None


def daily_frame(daily, date_from, date_to):
    days = pd.date_range(date_from, date_to, freq="D").strftime("%Y-%m-%d")
    base = pd.DataFrame({"day": days})
    got = pd.DataFrame(daily, columns=["day", "requests", "errors", "tokens"])
    frame = base.merge(got, on="day", how="left").fillna(0)
    return frame.astype({"requests": int, "errors": int, "tokens": int})


def show_usage():
    client = st.session_state.client

    st.header("Usage")

    try:
        keys = call(client.list_keys)
    except ApiError as err:
        st.error(friendly(err))
        return

    options = {"All keys": None}
    for key in keys:
        options[f"{key['name']} ({key['key_prefix']}...)"] = key["id"]

    period_col, key_col, refresh_col = st.columns([2, 3, 1])
    with period_col:
        date_range = pick_range()
    with key_col:
        key_label = st.selectbox("Key", list(options.keys()))
    with refresh_col:
        st.write("")
        st.button("Refresh")

    if date_range is None:
        st.info("Pick an end date to see usage.")
        return

    date_from, date_to = date_range
    key_id = options[key_label]

    try:
        data = call(client.usage, date_from.isoformat(), date_to.isoformat(), key_id)
        logs = call(client.logs, key_id, 50)
    except ApiError as err:
        st.error(friendly(err))
        return

    summary = data["range"]
    card1, card2, card3, card4 = st.columns(4)
    card1.metric("Requests", f"{summary['requests']:,}")
    card2.metric("Tokens", f"{summary['tokens']:,}")
    card3.metric("Error rate", f"{summary['error_rate'] * 100:.1f}%")
    card4.metric("Avg latency", f"{summary['avg_latency_ms']:.0f} ms")

    tk = data["tokens"]
    st.caption(
        f"Requests: {data['today']:,} today, {data['this_month']:,} this month, "
        f"{data['all_time']:,} all time. "
        f"Tokens: {tk['today']:,} today, {tk['this_month']:,} this month, "
        f"{tk['all_time']:,} all time."
    )

    if summary["requests"] == 0:
        st.info("No requests in this period. Make a call with one of your keys, then refresh.")
    else:
        frame = daily_frame(data["daily"], date_from, date_to)
        left, right = st.columns(2)
        with left:
            st.subheader("Requests per day")
            st.bar_chart(frame.set_index("day")["requests"])
        with right:
            st.subheader("Tokens per day")
            st.bar_chart(frame.set_index("day")["tokens"])

        st.subheader("Usage by key")
        by_key = pd.DataFrame(
            {
                "Key": [r["name"] for r in data["by_key"]],
                "Prefix": [r["key_prefix"] + "..." for r in data["by_key"]],
                "Requests": [r["requests"] for r in data["by_key"]],
                "Errors": [r["errors"] for r in data["by_key"]],
                "Tokens": [r["tokens"] for r in data["by_key"]],
            }
        )
        st.dataframe(by_key, hide_index=True)

    st.subheader("Recent requests")
    if logs:
        table = pd.DataFrame(
            {
                "Time (UTC)": pd.to_datetime([r["created_at"] for r in logs]).strftime(
                    "%Y-%m-%d %H:%M:%S"
                ),
                "Key": [r["key_name"] for r in logs],
                "Method": [r["method"] for r in logs],
                "Endpoint": [r["endpoint"] for r in logs],
                "Status": [r["status_code"] for r in logs],
                "Latency (ms)": [round(r["latency_ms"], 1) for r in logs],
                "Tokens": [r["tokens"] for r in logs],
            }
        )
        st.dataframe(table, hide_index=True)
        st.caption("The latest 50 requests from the last 30 days, whatever period is selected above.")
    else:
        st.caption("No requests in the last 30 days.")


EXAMPLE_POWERSHELL = """$headers = @{ Authorization = "Bearer YOUR_API_KEY" }
$body = @{ model = "dummy-small"; messages = @(@{ role = "user"; content = "Hello!" }) } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri __BASE__/v1/chat/completions -Headers $headers -ContentType "application/json" -Body $body"""

EXAMPLE_CURL = """curl __BASE__/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "dummy-small", "messages": [{"role": "user", "content": "Hello!"}]}'"""

EXAMPLE_PYTHON = """import requests

res = requests.post(
    "__BASE__/v1/chat/completions",
    headers={"Authorization": "Bearer YOUR_API_KEY"},
    json={"model": "dummy-small", "messages": [{"role": "user", "content": "Hello!"}]},
)
print(res.status_code, res.json())"""

EXAMPLE_JAVASCRIPT = """const res = await fetch("__BASE__/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: "Bearer YOUR_API_KEY", "Content-Type": "application/json" },
  body: JSON.stringify({ model: "dummy-small", messages: [{ role: "user", content: "Hello!" }] }),
});
console.log(res.status, await res.json());"""

REFERENCE = """**Endpoints**

| Method | Path | Permission | What it does |
|---|---|---|---|
| GET | `/v1/models` | `models` | Lists the available models |
| POST | `/v1/chat/completions` | `chat` | Returns a dummy chat reply with token counts |

**Errors**

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_model`, `invalid_messages` | The request body is wrong |
| 401 | `missing_key`, `invalid_key`, `key_revoked`, `key_expired` | The key is missing, unknown, revoked or expired |
| 403 | `scope_forbidden` | The key doesn't have permission for this endpoint |
| 429 | `rate_limit_exceeded` | Too many requests. Wait for `Retry-After` seconds |

Responses to authenticated requests include `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (seconds until the window resets)."""


def show_quickstart():
    st.header("Quickstart")
    st.write(
        "Call the DummyAI API with any key from the API keys page. "
        "Replace `YOUR_API_KEY` in the examples with your key."
    )

    tab_ps, tab_curl, tab_py, tab_js = st.tabs(["PowerShell", "curl", "Python", "JavaScript"])
    with tab_ps:
        st.code(EXAMPLE_POWERSHELL.replace("__BASE__", BASE_URL), language="powershell")
    with tab_curl:
        st.code(EXAMPLE_CURL.replace("__BASE__", BASE_URL), language="bash")
    with tab_py:
        st.code(EXAMPLE_PYTHON.replace("__BASE__", BASE_URL), language="python")
    with tab_js:
        st.code(EXAMPLE_JAVASCRIPT.replace("__BASE__", BASE_URL), language="javascript")

    st.markdown(REFERENCE)

    st.subheader("Try it")
    st.caption(
        "Sends a real request using only the key you paste, just like your own app would. "
        "It counts toward that key's usage."
    )
    with st.form("try_it_form"):
        key = st.text_input("API key", type="password", placeholder="ak_live_...")
        model = st.selectbox("Model", ["dummy-small", "dummy-medium", "dummy-large"])
        message = st.text_area("Message", value="Explain API keys in one sentence.")
        send = st.form_submit_button("Send request")

    if send:
        if not key.strip():
            st.error("Paste an API key first.")
            return
        try:
            result = try_chat(key.strip(), model, message)
        except ApiError as err:
            st.error(friendly(err))
            return

        status = result["status"]
        report = st.success if status == 200 else st.error
        report(f"HTTP {status} in {result['elapsed_ms']} ms")
        if result["headers"]:
            st.caption(" | ".join(f"{name}: {value}" for name, value in result["headers"].items()))
        st.json(result["body"])


def apply_plan(client, target):
    try:
        result = call(client.change_plan, target)
    except ApiError as err:
        st.error(friendly(err))
        return
    limit = result["rate_limit_per_min"]
    st.session_state.notice = (
        f"You're now on the {target.title()} plan. Every key allows {limit:,} requests per minute."
    )
    st.rerun()


def render_switch(client, plan, current, active):
    target = plan["id"]

    if plan["rate_limit_per_min"] > current["rate_limit_per_min"]:
        if st.button(f"Upgrade to {target.title()}", key=f"switch_{target}"):
            apply_plan(client, target)
        return

    too_many = active > plan["max_active_keys"]
    if too_many:
        st.warning(
            f"You have {active} active keys and the {target.title()} plan allows "
            f"{plan['max_active_keys']}. Revoke {active - plan['max_active_keys']} first."
        )
    confirmed = st.checkbox(
        f"Each key will drop to {plan['rate_limit_per_min']:,} requests per minute.",
        key=f"confirm_{target}",
        disabled=too_many,
    )
    if st.button(
        f"Switch to {target.title()}",
        key=f"switch_{target}",
        disabled=too_many or not confirmed,
    ):
        apply_plan(client, target)


def show_plan():
    client = st.session_state.client
    user = st.session_state.user

    notice = st.session_state.get("notice")
    if notice:
        st.success(notice)
        st.session_state.notice = None

    st.header("Plan")

    try:
        plans = call(client.plans)
        keys = call(client.list_keys)
    except ApiError as err:
        st.error(friendly(err))
        return

    current = next((p for p in plans if p["id"] == user["plan"]), None)
    if current is None:
        st.error("Your plan isn't in the list of plans. Try again later.")
        return

    active = sum(1 for k in keys if key_status(k) == "Active")
    st.write(f"You're on the {user['plan'].title()} plan and have {active} active key(s).")

    for col, plan in zip(st.columns(len(plans)), plans):
        with col.container(border=True):
            st.subheader(plan["id"].title())
            st.write(f"{plan['rate_limit_per_min']:,} requests per minute per key")
            st.write(f"Up to {plan['max_active_keys']} active keys")
            if plan["id"] == user["plan"]:
                st.write("Your current plan")
            else:
                render_switch(client, plan, current, active)

    st.caption(
        "Payments aren't connected in this demo, so switching plans is free and instant. "
        "A plan change updates every key you own right away."
    )


PAGES = {
    "Usage": show_usage,
    "API keys": show_keys,
    "Quickstart": show_quickstart,
    "Plan": show_plan,
}


def main():
    if st.session_state.user is None:
        show_auth()
        return

    client = st.session_state.client
    try:
        st.session_state.user = call(client.me)
    except ApiError as err:
        st.error(friendly(err))
        st.stop()

    user = st.session_state.user
    with st.sidebar:
        st.markdown("### DummyAI console")
        st.write(user["email"])
        page = st.radio("Go to", list(PAGES.keys()), label_visibility="collapsed")
        if st.button("Log out"):
            try:
                client.logout()
            except ApiError:
                pass
            reset_session()
            st.rerun()

    PAGES[page]()


main()