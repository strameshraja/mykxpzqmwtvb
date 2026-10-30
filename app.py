"""
Meridian backend — thin proxy between the React frontend and ICICI Breeze API.

Why this exists:
- breeze-connect is a Python library; it cannot run in the browser.
- Your api_secret must never reach the frontend. This server keeps it in
  memory only (loaded from a local .env file) and never sends it to React.
- The frontend only ever sends/receives: a login URL, a one-time session
  token, and JSON market/order data.

Run:
    pip install -r requirements.txt
    cp .env.example .env      # then fill in your real keys
    python app.py

The server starts on http://localhost:5000 by default.
"""

import os
import re
import secrets
import sqlite3
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone

from flask import Flask, request, jsonify, session, g
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
from dotenv import load_dotenv
from breeze_connect import BreezeConnect

load_dotenv()

APP_API_KEY = os.getenv("BREEZE_API_KEY", "7bB45$kK*j85!945Z2Bt48R7C857f32e")
APP_API_SECRET = os.getenv("BREEZE_API_SECRET", "v5n(88558696F805Nb$51B5188729144")
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")
PORT = int(os.getenv("PORT", "5000"))

if not APP_API_KEY or not APP_API_SECRET:
    print("WARNING: BREEZE_API_KEY / BREEZE_API_SECRET are not set. "
          "Copy .env.example to .env and fill them in before connecting.")

app = Flask(__name__)
CORS(app, origins=[FRONTEND_ORIGIN], supports_credentials=True)

# ---------------------------------------------------------------------------
# App login, users and admin console
#   * Users live in a SQLite file (app.db) — tables: users, reset_requests, audit_log.
#   * Passwords and recovery words are stored as salted hashes. Nobody — including the
#     admin — can read them back; the admin can issue a temporary password instead.
#   * Admin accounts can only be created by this server (seeded below). Registration
#     through the web page always creates a normal user.
#   * A normal user can log in only after the admin marks payment as "paid".
#   * Every /api/* route except the public auth ones requires a valid login.
#   * Each logged-in user gets their OWN Breeze session (see user_state / state below).
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.getenv("APP_DB", os.path.join(BASE_DIR, "app.db"))
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "starmeshraja")
# Default admin password — it is only used to CREATE the admin the first time. Change it after
# your first login; once an admin exists in app.db this default is never used again.
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "Newjersy^!74")
HASH_METHOD = os.getenv("PASSWORD_HASH_METHOD", "pbkdf2:sha256:600000")
MAX_FAILED_LOGINS = 5
LOCK_MINUTES = 15


def _load_secret_key():
    env_key = os.getenv("SECRET_KEY")
    if env_key:
        return env_key
    path = os.path.join(BASE_DIR, ".secret_key")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            key = fh.read().strip()
            if key:
                return key
    except OSError:
        pass
    key = secrets.token_hex(32)
    try:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(key)
    except OSError:
        pass  # sessions will simply reset when the server restarts
    return key


app.secret_key = _load_secret_key()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.getenv("COOKIE_SECURE", "0") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
)


def _utcnow():
    return datetime.now(timezone.utc)


def _iso(dt=None):
    return (dt or _utcnow()).strftime("%Y-%m-%dT%H:%M:%SZ")


def _hash(value):
    return generate_password_hash(value, method=HASH_METHOD)


_DUMMY_HASH = _hash("not-a-real-password")  # makes unknown usernames cost the same time as real ones

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash        TEXT NOT NULL,
    recovery_hash        TEXT,
    role                 TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    full_name            TEXT,
    email                TEXT,
    phone                TEXT,
    payment_status       TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid')),
    payment_reference    TEXT,
    paid_on              TEXT,
    is_active            INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    failed_logins        INTEGER NOT NULL DEFAULT 0,
    locked_until         TEXT,
    created_at           TEXT NOT NULL,
    last_login_at        TEXT
);
CREATE TABLE IF NOT EXISTS reset_requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT NOT NULL,
    note         TEXT,
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed')),
    requested_at TEXT NOT NULL,
    resolved_at  TEXT,
    resolved_by  TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    at     TEXT NOT NULL,
    actor  TEXT,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT,
    ip     TEXT
);
"""


def _connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def db():
    if "db" not in g:
        g.db = _connect()
    return g.db


@app.teardown_appcontext
def _close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db():
    conn = _connect()
    try:
        conn.executescript(SCHEMA)
        if not conn.execute("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").fetchone():
            conn.execute(
                "INSERT INTO users (username, password_hash, role, full_name, payment_status, paid_on, created_at) "
                "VALUES (?, ?, 'admin', 'Administrator', 'paid', ?, ?)",
                (ADMIN_USERNAME, _hash(ADMIN_PASSWORD), _iso(), _iso()),
            )
            conn.commit()
            print(f"Admin account '{ADMIN_USERNAME}' created. Log in and change its password.")
    finally:
        conn.close()


def audit(action, target=None, detail=None, actor=None):
    if actor is None:
        user = getattr(g, "user", None)
        actor = user["username"] if user else None
    db().execute(
        "INSERT INTO audit_log (at, actor, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)",
        (_iso(), actor, action, target, detail, request.remote_addr),
    )
    db().commit()


def public_user(row):
    return {
        "id": row["id"],
        "username": row["username"],
        "role": row["role"],
        "full_name": row["full_name"],
        "email": row["email"],
        "phone": row["phone"],
        "payment_status": row["payment_status"],
        "must_change_password": bool(row["must_change_password"]),
    }


# ---- per-user Breeze state --------------------------------------------------
# The route code below keeps using `state["breeze"]`, `state["watchlist"]` ... but `state`
# now resolves to the CURRENT LOGGED-IN USER's own dict, so one user can never see or
# trade through another user's broker session.
_USER_STATES = {}


def user_state(uid):
    if uid not in _USER_STATES:
        _USER_STATES[uid] = {
            "breeze": None,
            "connected_at": None,
            "customer_details": None,
            "watchlist": list(DEFAULT_WATCHLIST),
        }
    return _USER_STATES[uid]


class _CurrentUserState:
    def _d(self):
        user = getattr(g, "user", None)
        if user is None:
            raise RuntimeError("No logged-in user in this request")
        return user_state(user["id"])

    def __getitem__(self, key):
        return self._d()[key]

    def __setitem__(self, key, value):
        self._d()[key] = value

    def get(self, key, default=None):
        return self._d().get(key, default)

    def __contains__(self, key):
        return key in self._d()


state = _CurrentUserState()


def require_session():
    if state["breeze"] is None:
        return jsonify({"error": "No active Breeze session. Connect first."}), 401
    return None


PUBLIC_PATHS = {
    "/api/auth/register",
    "/api/auth/login",
    "/api/auth/reset-password",
    "/api/auth/request-reset",
    "/api/auth/me",
}


@app.before_request
def _auth_gate():
    if request.method == "OPTIONS" or not request.path.startswith("/api/"):
        return None
    g.user = None
    uid = session.get("uid")
    if uid:
        row = db().execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        # checked on EVERY request, so blocking a user or un-marking payment takes effect immediately
        if row and row["is_active"] and (row["role"] == "admin" or row["payment_status"] == "paid"):
            g.user = row
        else:
            session.clear()
    if request.path in PUBLIC_PATHS:
        return None
    if g.user is None:
        return jsonify({"error": "Please log in.", "auth_required": True}), 401
    if request.path.startswith("/api/admin/") and g.user["role"] != "admin":
        return jsonify({"error": "Admin only."}), 403
    if g.user["must_change_password"] and request.path not in ("/api/auth/change-password", "/api/auth/logout"):
        return jsonify({"error": "You must change your temporary password first.", "must_change_password": True}), 403
    return None


_USERNAME_RE = re.compile(r"^[A-Za-z0-9._-]{3,32}$")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_REG_LOG = {}  # ip -> recent registration timestamps (simple flood guard)


def _password_problem(password, username):
    if len(password) < 8:
        return "Password must be at least 8 characters."
    if len(password) > 128:
        return "Password is too long (max 128 characters)."
    if password.lower() == (username or "").lower():
        return "Password must not be the same as the username."
    return None


def _norm_word(word):
    return " ".join(str(word or "").lower().split())


def _record_failure(row):
    """Count a failed password / recovery-word attempt; lock the account after too many."""
    n = (row["failed_logins"] or 0) + 1
    locked = None
    if n >= MAX_FAILED_LOGINS:
        locked = _iso(_utcnow() + timedelta(minutes=LOCK_MINUTES))
        n = 0
    db().execute("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?", (n, locked, row["id"]))
    db().commit()


def _is_locked(row):
    return bool(row and row["locked_until"] and row["locked_until"] > _iso())


@app.route("/api/auth/register", methods=["POST"])
def auth_register():
    body = request.get_json(silent=True) or {}
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    full_name = str(body.get("full_name", "")).strip()[:80]
    email = str(body.get("email", "")).strip()[:120]
    phone = str(body.get("phone", "")).strip()[:20]
    recovery = _norm_word(body.get("recovery_word"))
    payment_ref = str(body.get("payment_reference", "")).strip()[:120]

    if not _USERNAME_RE.match(username):
        return jsonify({"error": "Username must be 3-32 characters: letters, digits, dot, dash or underscore."}), 400
    problem = _password_problem(password, username)
    if problem:
        return jsonify({"error": problem}), 400
    if not full_name:
        return jsonify({"error": "Please enter your full name."}), 400
    if not _EMAIL_RE.match(email):
        return jsonify({"error": "Please enter a valid email address."}), 400
    if len(recovery) < 4:
        return jsonify({"error": "Recovery word must be at least 4 characters (you will need it to reset your password)."}), 400

    now = _utcnow().timestamp()
    recent = [t for t in _REG_LOG.get(request.remote_addr, []) if now - t < 3600]
    if len(recent) >= 5:
        return jsonify({"error": "Too many registrations from this address. Try again later."}), 429
    _REG_LOG[request.remote_addr] = recent + [now]

    try:
        # role is NEVER taken from the request — web registration can only create normal users
        db().execute(
            "INSERT INTO users (username, password_hash, recovery_hash, role, full_name, email, phone, "
            "payment_status, payment_reference, created_at) VALUES (?, ?, ?, 'user', ?, ?, ?, 'pending', ?, ?)",
            (username, _hash(password), _hash(recovery), full_name, email, phone, payment_ref or None, _iso()),
        )
        db().commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "That username is already taken."}), 409
    audit("register", target=username, actor=username)
    return jsonify({"ok": True, "message": "Registered. You can log in once the admin confirms your payment."}), 201


@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    body = request.get_json(silent=True) or {}
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    row = db().execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()

    if _is_locked(row):
        return jsonify({"error": f"Too many failed attempts. Try again in about {LOCK_MINUTES} minutes."}), 429
    password_ok = check_password_hash(row["password_hash"] if row else _DUMMY_HASH, password)
    if not (row and password_ok):
        if row:
            _record_failure(row)
        audit("login_failed", target=username, actor=username)
        return jsonify({"error": "Invalid username or password."}), 401

    # the password is right — only now reveal account-state problems
    if not row["is_active"]:
        return jsonify({"error": "This account has been blocked. Please contact the admin."}), 403
    if row["role"] != "admin" and row["payment_status"] != "paid":
        return jsonify({"error": "Your payment has not been confirmed yet. You can log in once the admin marks it as paid.", "payment_pending": True}), 403

    db().execute("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?", (_iso(), row["id"]))
    db().commit()
    session.clear()
    session["uid"] = row["id"]
    session.permanent = True
    g.user = row
    audit("login", target=username, actor=username)
    return jsonify({"user": public_user(row)})


@app.route("/api/auth/me", methods=["GET"])
def auth_me():
    user = getattr(g, "user", None)
    return jsonify({"user": public_user(user) if user else None})


@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    user = g.user
    _USER_STATES.pop(user["id"], None)  # drops this user's Breeze session too
    audit("logout", target=user["username"])
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/auth/change-password", methods=["POST"])
def auth_change_password():
    body = request.get_json(silent=True) or {}
    user = g.user
    if not check_password_hash(user["password_hash"], str(body.get("old_password", ""))):
        return jsonify({"error": "Current password is incorrect."}), 400
    new_password = str(body.get("new_password", ""))
    problem = _password_problem(new_password, user["username"])
    if problem:
        return jsonify({"error": problem}), 400
    db().execute("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", (_hash(new_password), user["id"]))
    db().commit()
    audit("change_password", target=user["username"])
    return jsonify({"ok": True})


@app.route("/api/auth/reset-password", methods=["POST"])
def auth_reset_password():
    """Self-service reset with the recovery word chosen at registration."""
    body = request.get_json(silent=True) or {}
    username = str(body.get("username", "")).strip()
    new_password = str(body.get("new_password", ""))
    row = db().execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    generic = (jsonify({"error": "Invalid username or recovery word."}), 400)

    if _is_locked(row):
        return jsonify({"error": f"Too many failed attempts. Try again in about {LOCK_MINUTES} minutes."}), 429
    stored = row["recovery_hash"] if row and row["role"] != "admin" and row["recovery_hash"] else None
    word_ok = check_password_hash(stored or _DUMMY_HASH, _norm_word(body.get("recovery_word")))
    if not (stored and word_ok):
        if row:
            _record_failure(row)
        audit("reset_failed", target=username, actor=username)
        return generic
    problem = _password_problem(new_password, username)
    if problem:
        return jsonify({"error": problem}), 400
    db().execute(
        "UPDATE users SET password_hash = ?, must_change_password = 0, failed_logins = 0, locked_until = NULL WHERE id = ?",
        (_hash(new_password), row["id"]),
    )
    db().commit()
    audit("reset_password_self", target=username, actor=username)
    return jsonify({"ok": True, "message": "Password changed. You can log in now."})


@app.route("/api/auth/request-reset", methods=["POST"])
def auth_request_reset():
    """For users who forgot the recovery word too: leaves a request for the admin."""
    body = request.get_json(silent=True) or {}
    username = str(body.get("username", "")).strip()
    note = str(body.get("note", "")).strip()[:200]
    row = db().execute("SELECT id FROM users WHERE username = ? AND role = 'user'", (username,)).fetchone()
    if row and not db().execute("SELECT 1 FROM reset_requests WHERE username = ? AND status = 'open'", (username,)).fetchone():
        db().execute("INSERT INTO reset_requests (username, note, requested_at) VALUES (?, ?, ?)", (username, note, _iso()))
        db().commit()
        audit("reset_requested", target=username, actor=username)
    # same answer whether or not the username exists
    return jsonify({"ok": True, "message": "If that account exists, the admin has been notified and will give you a temporary password."})


# ---- admin console API ----------------------------------------------------------------------
def _admin_user_dict(r):
    return {
        "id": r["id"], "username": r["username"], "role": r["role"], "full_name": r["full_name"],
        "email": r["email"], "phone": r["phone"], "payment_status": r["payment_status"],
        "payment_reference": r["payment_reference"], "paid_on": r["paid_on"], "is_active": bool(r["is_active"]),
        "must_change_password": bool(r["must_change_password"]), "created_at": r["created_at"],
        "last_login_at": r["last_login_at"], "locked": _is_locked(r), "has_recovery_word": bool(r["recovery_hash"]),
        "has_broker_session": bool(_USER_STATES.get(r["id"], {}).get("breeze")),
    }


def _target_user(uid):
    return db().execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()


@app.route("/api/admin/users", methods=["GET"])
def admin_users():
    rows = db().execute("SELECT * FROM users ORDER BY id").fetchall()
    users = [_admin_user_dict(r) for r in rows]
    normal = [u for u in users if u["role"] == "user"]
    stats = {
        "total_users": len(normal),
        "paid": sum(1 for u in normal if u["payment_status"] == "paid"),
        "awaiting_payment": sum(1 for u in normal if u["payment_status"] != "paid"),
        "blocked": sum(1 for u in normal if not u["is_active"]),
        "open_reset_requests": db().execute("SELECT COUNT(*) FROM reset_requests WHERE status = 'open'").fetchone()[0],
    }
    return jsonify({"users": users, "stats": stats})


@app.route("/api/admin/users/<int:uid>/payment", methods=["POST"])
def admin_set_payment(uid):
    body = request.get_json(silent=True) or {}
    status = body.get("status")
    row = _target_user(uid)
    if not row or row["role"] != "user":
        return jsonify({"error": "Normal user not found."}), 404
    if status not in ("paid", "pending"):
        return jsonify({"error": "status must be 'paid' or 'pending'."}), 400
    reference = str(body.get("reference", "")).strip()[:120] or row["payment_reference"]
    db().execute(
        "UPDATE users SET payment_status = ?, payment_reference = ?, paid_on = ? WHERE id = ?",
        (status, reference, _iso() if status == "paid" else None, uid),
    )
    db().commit()
    if status != "paid":
        _USER_STATES.pop(uid, None)
    audit("payment_" + status, target=row["username"], detail=reference)
    return jsonify({"ok": True})


@app.route("/api/admin/users/<int:uid>/active", methods=["POST"])
def admin_set_active(uid):
    body = request.get_json(silent=True) or {}
    row = _target_user(uid)
    if not row or row["role"] != "user":
        return jsonify({"error": "Normal user not found."}), 404
    active = 1 if body.get("active") else 0
    db().execute("UPDATE users SET is_active = ? WHERE id = ?", (active, uid))
    db().commit()
    if not active:
        _USER_STATES.pop(uid, None)
    audit("unblock" if active else "block", target=row["username"])
    return jsonify({"ok": True})


@app.route("/api/admin/users/<int:uid>/reset-password", methods=["POST"])
def admin_reset_password(uid):
    row = _target_user(uid)
    if not row or row["role"] != "user":
        return jsonify({"error": "Normal user not found."}), 404
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
    temp = "".join(secrets.choice(alphabet) for _ in range(12))
    db().execute(
        "UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE id = ?",
        (_hash(temp), uid),
    )
    db().execute(
        "UPDATE reset_requests SET status = 'done', resolved_at = ?, resolved_by = ? WHERE username = ? AND status = 'open'",
        (_iso(), g.user["username"], row["username"]),
    )
    db().commit()
    audit("admin_reset_password", target=row["username"])
    return jsonify({"ok": True, "temp_password": temp})  # shown to the admin once; only a hash is kept


@app.route("/api/admin/users/<int:uid>", methods=["DELETE"])
def admin_delete_user(uid):
    row = _target_user(uid)
    if not row or row["role"] != "user":
        return jsonify({"error": "Normal user not found."}), 404
    db().execute("DELETE FROM users WHERE id = ?", (uid,))
    db().commit()
    _USER_STATES.pop(uid, None)
    audit("delete_user", target=row["username"])
    return jsonify({"ok": True})


@app.route("/api/admin/reset-requests", methods=["GET"])
def admin_reset_requests():
    rows = db().execute("SELECT * FROM reset_requests ORDER BY (status = 'open') DESC, id DESC LIMIT 200").fetchall()
    return jsonify({"requests": [dict(r) for r in rows]})


@app.route("/api/admin/reset-requests/<int:rid>/dismiss", methods=["POST"])
def admin_dismiss_request(rid):
    db().execute(
        "UPDATE reset_requests SET status = 'dismissed', resolved_at = ?, resolved_by = ? WHERE id = ? AND status = 'open'",
        (_iso(), g.user["username"], rid),
    )
    db().commit()
    audit("reset_request_dismissed", target=str(rid))
    return jsonify({"ok": True})


@app.route("/api/admin/audit", methods=["GET"])
def admin_audit():
    rows = db().execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT 300").fetchall()
    return jsonify({"entries": [dict(r) for r in rows]})


def _cli_reset_admin():
    """python app.py reset-admin   — set a new password for the admin if you ever lose it."""
    import getpass

    pw1 = getpass.getpass(f"New password for admin '{ADMIN_USERNAME}': ")
    if pw1 != getpass.getpass("Repeat the new password: "):
        print("Passwords do not match.")
        return
    problem = _password_problem(pw1, ADMIN_USERNAME)
    if problem:
        print(problem)
        return
    conn = _connect()
    try:
        cur = conn.execute(
            "UPDATE users SET password_hash = ?, must_change_password = 0, failed_logins = 0, locked_until = NULL, is_active = 1 "
            "WHERE username = ? AND role = 'admin'",
            (_hash(pw1), ADMIN_USERNAME),
        )
        conn.commit()
        print("Admin password updated." if cur.rowcount else f"No admin named '{ADMIN_USERNAME}' found.")
    finally:
        conn.close()


init_db()


# ---------------------------------------------------------------------------
# Auth / session
# ---------------------------------------------------------------------------

@app.route("/api/login-url", methods=["GET"])
def login_url():
    """Returns the URL the user must open in a browser to log in to ICICI
    Direct and obtain their API_Session value from the redirect."""
    if not APP_API_KEY:
        return jsonify({"error": "Server is missing BREEZE_API_KEY"}), 500
    url = "https://api.icicidirect.com/apiuser/login?api_key=" + urllib.parse.quote_plus(APP_API_KEY)
    return jsonify({"login_url": url})


@app.route("/api/session", methods=["POST"])
def create_session():
    """Body: { "session_token": "<API_Session value copied from the redirect URL>" }"""
    data = request.get_json(silent=True) or {}
    session_token = data.get("session_token", "").strip()
    if not session_token:
        return jsonify({"error": "session_token is required"}), 400

    try:
        breeze = BreezeConnect(api_key=APP_API_KEY)
        breeze.generate_session(api_secret=APP_API_SECRET, session_token=session_token)
    except Exception as exc:  # noqa: BLE001 — surface the real Breeze error to the caller
        import traceback
        traceback.print_exc()  # full traceback printed to the Flask terminal for debugging
        return jsonify({"error": f"Failed to establish Breeze session: {exc}"}), 400

    state["breeze"] = breeze
    state["connected_at"] = datetime.now(timezone.utc).isoformat()

    try:
        details = breeze.get_customer_details(api_session=session_token)
        state["customer_details"] = details
    except Exception:  # noqa: BLE001 — non-fatal, session still works without this
        state["customer_details"] = None

    return jsonify({
        "connected": True,
        "connected_at": state["connected_at"],
        "customer_details": state["customer_details"],
    })


@app.route("/api/disconnect", methods=["POST"])
def disconnect():
    state["breeze"] = None
    state["connected_at"] = None
    state["customer_details"] = None
    return jsonify({"connected": False})


@app.route("/api/status", methods=["GET"])
def status():
    return jsonify({
        "connected": state["breeze"] is not None,
        "connected_at": state["connected_at"],
    })


# ---------------------------------------------------------------------------
# Market data
# ---------------------------------------------------------------------------

# Breeze identifies instruments by stock_code + exchange_code, not by the
# ticker symbol you see on an exchange. Edit this list for the instruments
# you actually want to watch. See Breeze's "Master Scrip File" docs to look
# up correct stock_codes for other symbols.
# Breeze identifies instruments by stock_code + exchange_code, not by the
# ticker symbol you see on an exchange. This starting list is just a
# default — the frontend can add/remove instruments at runtime via
# /api/watchlist/add and /api/watchlist/remove, backed by get_names() search.
DEFAULT_WATCHLIST = [
    {"label": "ICICI Bank", "stock_code": "ICIBAN", "exchange_code": "NSE", "product_type": "cash"},
    {"label": "Reliance",   "stock_code": "RELIND", "exchange_code": "NSE", "product_type": "cash"},
    {"label": "TCS",        "stock_code": "TCS",    "exchange_code": "NSE", "product_type": "cash"},
    {"label": "Infosys",    "stock_code": "INFTEC", "exchange_code": "NSE", "product_type": "cash"},
    {"label": "HDFC Bank",  "stock_code": "HDFBAN", "exchange_code": "NSE", "product_type": "cash"},
]
# (each user's watchlist starts from DEFAULT_WATCHLIST — see user_state())

# A handful of common indices Breeze supports that don't show up well
# through get_names() (which is built for equities). Offered as suggestions
# alongside live search results so users can add indices too.
COMMON_INDICES = [
    {"label": "Nifty 50",       "stock_code": "NIFTY",  "exchange_code": "NSE", "product_type": "cash"},
    {"label": "Nifty Bank",     "stock_code": "CNXBAN", "exchange_code": "NSE", "product_type": "cash"},
    {"label": "Nifty Fin Serv", "stock_code": "NIFFIN", "exchange_code": "NSE", "product_type": "cash"},
    {"label": "Nifty Midcap",   "stock_code": "NIFMID", "exchange_code": "NSE", "product_type": "cash"},
    {"label": "Sensex",         "stock_code": "BSESEN", "exchange_code": "BSE", "product_type": "cash"},
]


@app.route("/api/watchlist", methods=["GET"])
def watchlist():
    err = require_session()
    if err:
        return err

    breeze = state["breeze"]
    results = []
    for item in state["watchlist"]:
        try:
            resp = breeze.get_quotes(
                stock_code=item["stock_code"],
                exchange_code=item["exchange_code"],
                product_type=item["product_type"],
            )
            row = (resp.get("Success") or [{}])[0] if isinstance(resp, dict) else {}
            results.append({
                "label": item["label"],
                "stock_code": item["stock_code"],
                "exchange_code": item["exchange_code"],
                "product_type": item["product_type"],
                "ltp": row.get("ltp"),
                "prev_close": row.get("previous_close") or row.get("close"),
                "raw": row,
            })
        except Exception as exc:  # noqa: BLE001 — keep other rows working if one symbol fails
            results.append({
                "label": item["label"],
                "stock_code": item["stock_code"],
                "exchange_code": item["exchange_code"],
                "product_type": item["product_type"],
                "error": str(exc),
            })
    return jsonify({"watchlist": results})


@app.route("/api/watchlist/add", methods=["POST"])
def watchlist_add():
    """Body: { "stock_code", "exchange_code", "label", "product_type" (optional, default 'cash') }"""
    data = request.get_json(silent=True) or {}
    stock_code = (data.get("stock_code") or "").strip()
    exchange_code = (data.get("exchange_code") or "NSE").strip()
    label = (data.get("label") or stock_code).strip()
    product_type = (data.get("product_type") or "cash").strip()
    if not stock_code:
        return jsonify({"error": "stock_code is required"}), 400

    already_present = any(
        w["stock_code"] == stock_code and w["exchange_code"] == exchange_code
        for w in state["watchlist"]
    )
    if not already_present:
        state["watchlist"].append({
            "label": label,
            "stock_code": stock_code,
            "exchange_code": exchange_code,
            "product_type": product_type,
        })
    return jsonify({"watchlist": state["watchlist"]})


@app.route("/api/watchlist/remove", methods=["POST"])
def watchlist_remove():
    """Body: { "stock_code", "exchange_code" }"""
    data = request.get_json(silent=True) or {}
    stock_code = data.get("stock_code")
    exchange_code = data.get("exchange_code")
    state["watchlist"] = [
        w for w in state["watchlist"]
        if not (w["stock_code"] == stock_code and w["exchange_code"] == exchange_code)
    ]
    return jsonify({"watchlist": state["watchlist"]})


@app.route("/api/quotes", methods=["GET"])
def quotes():
    err = require_session()
    if err:
        return err
    stock_code = request.args.get("stock_code")
    exchange_code = request.args.get("exchange_code", "NSE")
    product_type = request.args.get("product_type", "cash")
    if not stock_code:
        return jsonify({"error": "stock_code is required"}), 400

    breeze = state["breeze"]
    try:
        resp = breeze.get_quotes(
            stock_code=stock_code,
            exchange_code=exchange_code,
            product_type=product_type,
        )
        return jsonify(resp)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 502


# ---------------------------------------------------------------------------
# Instrument search (typeahead for "add to watchlist")
# ---------------------------------------------------------------------------

@app.route("/api/search", methods=["GET"])
def search_instruments():
    """?q=<partial name or code>&exchange_code=NSE (optional)

    Breeze doesn't offer a true fuzzy-search endpoint; get_names() expects a
    fairly close match to a real stock_code/name. We try the raw query as
    typed, plus an upper-cased version, against NSE and BSE, and also match
    it against a small local list of common indices so users can find those
    too. Results are best-effort — if nothing matches, the array is empty
    rather than erroring, so the UI can just show "no matches" cleanly.
    """
    err = require_session()
    if err:
        return err
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify({"results": []})

    breeze = state["breeze"]
    seen = set()
    results = []

    # Local index matches first (cheap, no API call)
    for idx in COMMON_INDICES:
        if q.lower() in idx["label"].lower() or q.lower() in idx["stock_code"].lower():
            key = (idx["stock_code"], idx["exchange_code"])
            if key not in seen:
                seen.add(key)
                results.append({**idx, "kind": "index"})

    for exch in ["NSE", "BSE"]:
        for candidate in [q.upper(), q]:
            try:
                resp = breeze.get_names(exchange_code=exch, stock_code=candidate)
            except Exception:  # noqa: BLE001 — a miss here is normal, not an error condition
                continue
            rows = resp if isinstance(resp, list) else [resp] if isinstance(resp, dict) else []
            for row in rows:
                if not isinstance(row, dict):
                    continue
                code = row.get("isec_stock_code") or row.get("stock_code")
                if not code:
                    continue
                key = (code, exch)
                if key in seen:
                    continue
                seen.add(key)
                results.append({
                    "label": row.get("isec_desc") or row.get("company_name") or code,
                    "stock_code": code,
                    "exchange_code": exch,
                    "product_type": "cash",
                    "kind": "equity",
                })

    return jsonify({"results": results[:15]})


# ---------------------------------------------------------------------------
# Historical candles (for the candlestick chart)
# ---------------------------------------------------------------------------

INTERVAL_LOOKBACK_DAYS = {
    "1minute": 1,
    "5minute": 3,
    "30minute": 15,
    "1day": 180,
}


@app.route("/api/candles", methods=["GET"])
def candles():
    """?stock_code=&exchange_code=NSE&product_type=cash&interval=1day"""
    err = require_session()
    if err:
        return err
    stock_code = request.args.get("stock_code")
    exchange_code = request.args.get("exchange_code", "NSE")
    product_type = request.args.get("product_type", "cash")
    interval = request.args.get("interval", "1day")
    if interval not in INTERVAL_LOOKBACK_DAYS:
        return jsonify({"error": f"interval must be one of {list(INTERVAL_LOOKBACK_DAYS)}"}), 400
    if not stock_code:
        return jsonify({"error": "stock_code is required"}), 400

    lookback_days = INTERVAL_LOOKBACK_DAYS[interval]
    to_dt = datetime.now(timezone.utc)
    from_dt = to_dt - timedelta(days=lookback_days)
    fmt = "%Y-%m-%dT%H:%M:%S.000Z"

    contract = dict(stock_code=stock_code, exchange_code=exchange_code, product_type=product_type)
    if product_type == "options":
        # option candles need ?expiry=YYYY-MM-DD&right=call|put&strike=22900
        try:
            expiry_dt = datetime.strptime(request.args.get("expiry"), "%Y-%m-%d")
            strike = str(int(float(request.args.get("strike"))))
        except (TypeError, ValueError):
            return jsonify({"error": "options candles need expiry (YYYY-MM-DD) and strike"}), 400
        contract.update(
            expiry_date=expiry_dt.strftime("%Y-%m-%dT07:00:00.000Z"),
            right=(request.args.get("right") or "call").lower(),
            strike_price=strike,
        )

    breeze = state["breeze"]
    try:
        resp = breeze.get_historical_data_v2(
            interval=interval,
            from_date=from_dt.strftime(fmt),
            to_date=to_dt.strftime(fmt),
            **contract,
        )
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 502

    rows = resp.get("Success") if isinstance(resp, dict) else None
    candles_out = []
    for row in rows or []:
        try:
            candles_out.append({
                "time": row.get("datetime"),
                "open": float(row.get("open")),
                "high": float(row.get("high")),
                "low": float(row.get("low")),
                "close": float(row.get("close")),
                "volume": float(row.get("volume") or 0),
            })
        except (TypeError, ValueError):
            continue

    return jsonify({"candles": candles_out})


# ---------------------------------------------------------------------------
# Positions / portfolio
# ---------------------------------------------------------------------------

@app.route("/api/positions", methods=["GET"])
def positions():
    err = require_session()
    if err:
        return err
    breeze = state["breeze"]
    try:
        resp = breeze.get_portfolio_positions()
        return jsonify(resp)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 502


# ---------------------------------------------------------------------------
# Funds
# ---------------------------------------------------------------------------

@app.route("/api/funds", methods=["GET"])
def funds():
    err = require_session()
    if err:
        return err
    breeze = state["breeze"]
    try:
        resp = breeze.get_funds()
        return jsonify(resp)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 502


# ---------------------------------------------------------------------------
# Orders
# ---------------------------------------------------------------------------

@app.route("/api/orders", methods=["POST"])
def place_order():
    """Body should contain the fields Breeze's place_order expects, e.g.:
    {
      "stock_code": "ICIBAN",
      "exchange_code": "NSE",
      "product": "cash",
      "action": "buy",
      "order_type": "market",
      "quantity": "1",
      "price": "0",
      "validity": "day",
      "stoploss": "0"
    }
    Check Breeze's official docs for the exact required fields for your
    product type (cash / futures / options), since required params differ.
    """
    err = require_session()
    if err:
        return err
    payload = request.get_json(silent=True) or {}

    required = ["stock_code", "exchange_code", "product", "action", "order_type", "quantity", "validity"]
    missing = [f for f in required if f not in payload]
    if missing:
        return jsonify({"error": f"Missing required fields: {', '.join(missing)}"}), 400

    breeze = state["breeze"]
    try:
        resp = breeze.place_order(**payload)
        return jsonify(resp)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 502


@app.route("/api/orders", methods=["GET"])
def order_list():
    err = require_session()
    if err:
        return err
    breeze = state["breeze"]
    exchange_code = request.args.get("exchange_code", "NSE")
    from_date = request.args.get("from_date")
    to_date = request.args.get("to_date")
    try:
        resp = breeze.get_order_list(exchange_code=exchange_code, from_date=from_date, to_date=to_date)
        return jsonify(resp)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 502


# ---------------------------------------------------------------------------
# Intraday expected range (ATM straddle range) — replicates the Pine Script
# "Earth & HLC Range" indicator's Line1-4 logic:
#   Line1 = ATM + prevClose(ATM Call)              -> conservative upper band
#   Line2 = ATM - prevClose(ATM Put)               -> conservative lower band
#   Line3 = ATM + (prevClose(Call) + prevClose(Put)) -> max upper band
#   Line4 = ATM - (prevClose(Call) + prevClose(Put)) -> max lower band
# ---------------------------------------------------------------------------

# Mirrors the Pine Script's per-index mapping (spot ticker + lot size).
INDEX_CONFIG = {
    "NIFTY":     {"stock_code": "NIFTY",  "lot_size": 75},
    "BANKNIFTY": {"stock_code": "CNXBAN", "lot_size": 30},
    "FINNIFTY":  {"stock_code": "NIFFIN", "lot_size": 60},
    "MIDCAP":    {"stock_code": "NIFMID", "lot_size": 120},
}


def _extract_price(quote_resp, prefer_prev_close=True):
    """Pull previous_close (or ltp as a fallback) out of a Breeze quote response."""
    if not isinstance(quote_resp, dict):
        return None
    rows = quote_resp.get("Success")
    row = (rows[0] if isinstance(rows, list) and rows else rows) if rows else None
    if not isinstance(row, dict):
        return None
    if prefer_prev_close:
        val = row.get("previous_close") or row.get("prev_close") or row.get("ltp")
    else:
        val = row.get("ltp") or row.get("previous_close")
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


@app.route("/api/intraday-range", methods=["GET"])
def intraday_range():
    """?symbol=NIFTY&atm=26250&expiry=2025-12-02  (expiry as YYYY-MM-DD from a date input)"""
    err = require_session()
    if err:
        return err

    symbol = (request.args.get("symbol") or "").strip().upper()
    atm_raw = request.args.get("atm")
    expiry_raw = request.args.get("expiry")  # YYYY-MM-DD

    if symbol not in INDEX_CONFIG:
        return jsonify({"error": f"symbol must be one of {list(INDEX_CONFIG)}"}), 400
    try:
        atm = float(atm_raw)
    except (TypeError, ValueError):
        return jsonify({"error": "atm must be a number (the ATM strike price)"}), 400
    try:
        expiry_dt = datetime.strptime(expiry_raw, "%Y-%m-%d")
    except (TypeError, ValueError):
        return jsonify({"error": "expiry must be in YYYY-MM-DD format"}), 400

    cfg = INDEX_CONFIG[symbol]
    stock_code = cfg["stock_code"]
    expiry_str = expiry_dt.strftime("%d-%b-%Y")  # Breeze's expected DD-MMM-YYYY format
    breeze = state["breeze"]

    warnings = []

    # ATM Call & Put previous-close prices
    ce_price = pe_price = None
    try:
        ce_resp = breeze.get_quotes(
            stock_code=stock_code, exchange_code="NFO", expiry_date=expiry_str,
            product_type="options", right="Call", strike_price=str(atm),
        )
        ce_price = _extract_price(ce_resp)
        if ce_price is None:
            warnings.append("Could not read a Call price from Breeze — check strike/expiry match a live contract.")
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"Call quote failed: {exc}")

    try:
        pe_resp = breeze.get_quotes(
            stock_code=stock_code, exchange_code="NFO", expiry_date=expiry_str,
            product_type="options", right="Put", strike_price=str(atm),
        )
        pe_price = _extract_price(pe_resp)
        if pe_price is None:
            warnings.append("Could not read a Put price from Breeze — check strike/expiry match a live contract.")
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"Put quote failed: {exc}")

    lines = None
    straddle_premium = None
    if ce_price is not None and pe_price is not None:
        straddle_premium = ce_price + pe_price
        lines = {
            "line1_min_upper": atm + ce_price,
            "line2_min_lower": atm - pe_price,
            "line3_max_upper": atm + straddle_premium,
            "line4_max_lower": atm - straddle_premium,
        }

    # Optional context: underlying's previous day H/L/C and today's open (TDO),
    # same fields the Pine Script plots when ShowHLC/ShowBlvl/etc are enabled.
    underlying = {}
    try:
        quote_resp = breeze.get_quotes(stock_code=stock_code, exchange_code="NSE", product_type="cash")
        rows = quote_resp.get("Success") if isinstance(quote_resp, dict) else None
        row = (rows[0] if rows else {}) or {}
        underlying["ltp"] = row.get("ltp")
        underlying["tdo_today_open"] = row.get("open")
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"Underlying quote failed: {exc}")

    try:
        to_dt = datetime.now(timezone.utc)
        from_dt = to_dt - timedelta(days=10)
        hist_resp = breeze.get_historical_data_v2(
            interval="1day",
            from_date=from_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            to_date=to_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            stock_code=stock_code, exchange_code="NSE", product_type="cash",
        )
        hist_rows = hist_resp.get("Success") if isinstance(hist_resp, dict) else []
        if hist_rows:
            # Last row may be today (still forming) — prefer the one before it as "previous day".
            prev_day_row = hist_rows[-2] if len(hist_rows) >= 2 else hist_rows[-1]
            underlying["pdh_prev_high"] = prev_day_row.get("high")
            underlying["pdl_prev_low"] = prev_day_row.get("low")
            underlying["pdc_prev_close"] = prev_day_row.get("close")
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"Previous-day history failed: {exc}")

    return jsonify({
        "symbol": symbol,
        "stock_code": stock_code,
        "lot_size": cfg["lot_size"],
        "atm": atm,
        "expiry_date": expiry_str,
        "ce_prev_close": ce_price,
        "pe_prev_close": pe_price,
        "straddle_premium": straddle_premium,
        "lines": lines,
        "underlying": underlying,
        "warnings": warnings,
    })


# ---------------------------------------------------------------------------
# Daily Sniper Levels
#   ATM          = NIFTY day close rounded to the nearest 100 (user can override)
#   Sniper value = (CE close @ ATM+100  +  PE close @ ATM-100) / 2
#   Upper band   = ATM + Sniper value
#   Lower band   = ATM - Sniper value
# ---------------------------------------------------------------------------

IST = timezone(timedelta(hours=5, minutes=30))
SNIPER_STEP = 100


def _latest_daily_bar(rows):
    """Return (close, 'YYYY-MM-DD', high) of the latest *completed* daily candle.

    If today's candle exists but the market is still open (before 15:30 IST),
    it is still forming, so the previous day's candle is used instead.
    """
    parsed = []
    for r in rows or []:
        try:
            close = float(r.get("close"))
        except (TypeError, ValueError):
            continue
        try:
            high = float(r.get("high"))
        except (TypeError, ValueError):
            high = None  # a missing high must never break the close used by the sniper levels
        parsed.append((str(r.get("datetime"))[:10], close, high))
    if not parsed:
        return None, None, None
    parsed.sort(key=lambda x: x[0])

    now_ist = datetime.now(IST)
    today = now_ist.strftime("%Y-%m-%d")
    before_close = (now_ist.hour, now_ist.minute) < (15, 30)
    if parsed[-1][0] == today and before_close and len(parsed) > 1:
        parsed = parsed[:-1]
    day, close, high = parsed[-1]
    return close, day, high


def _latest_daily_close(rows):
    close, day, _high = _latest_daily_bar(rows)
    return close, day


def _fetch_daily_rows(breeze, **contract):
    to_dt = datetime.now(timezone.utc)
    from_dt = to_dt - timedelta(days=10)
    fmt = "%Y-%m-%dT%H:%M:%S.000Z"
    resp = breeze.get_historical_data_v2(
        interval="1day",
        from_date=from_dt.strftime(fmt),
        to_date=to_dt.strftime(fmt),
        **contract,
    )
    return resp.get("Success") if isinstance(resp, dict) else None


@app.route("/api/sniper-levels", methods=["GET"])
def sniper_levels():
    """?expiry=YYYY-MM-DD&atm=22800 (atm optional; omitted = auto from NIFTY close)"""
    err = require_session()
    if err:
        return err

    expiry_raw = request.args.get("expiry")
    atm_raw = (request.args.get("atm") or "").strip()
    try:
        expiry_dt = datetime.strptime(expiry_raw, "%Y-%m-%d")
    except (TypeError, ValueError):
        return jsonify({"error": "expiry must be in YYYY-MM-DD format"}), 400

    atm_override = None
    if atm_raw:
        try:
            atm_override = float(atm_raw)
        except ValueError:
            return jsonify({"error": "atm must be a number"}), 400

    breeze = state["breeze"]
    warnings = []
    expiry_iso = expiry_dt.strftime("%Y-%m-%dT07:00:00.000Z")

    # 1) NIFTY day close -> auto ATM (nearest 100, halves round up)
    nifty_close = nifty_close_date = None
    try:
        rows = _fetch_daily_rows(breeze, stock_code="NIFTY", exchange_code="NSE", product_type="cash")
        nifty_close, nifty_close_date = _latest_daily_close(rows)
        if nifty_close is None:
            warnings.append("No NIFTY daily candle returned by Breeze.")
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"NIFTY daily close failed: {exc}")

    atm_auto = None
    if nifty_close is not None:
        atm_auto = int(nifty_close / SNIPER_STEP + 0.5) * SNIPER_STEP

    atm = atm_override if atm_override is not None else atm_auto
    if atm is None:
        return jsonify({
            "error": "Could not determine ATM — NIFTY close unavailable. Enter the ATM strike manually.",
            "warnings": warnings,
        }), 502

    ce_strike = atm + SNIPER_STEP
    pe_strike = atm - SNIPER_STEP

    # 2) Sniper level for ATM, ATM+1 and ATM-1 (each centre strike C uses
    #    CE close @ C+100 and PE close @ C-100)
    def option_close(right, strike):
        try:
            rows = _fetch_daily_rows(
                breeze, stock_code="NIFTY", exchange_code="NFO", product_type="options",
                expiry_date=expiry_iso, right=right, strike_price=str(int(strike)),
            )
            close, day, high = _latest_daily_bar(rows)
            if close is None:
                warnings.append(f"No daily close for NIFTY {int(strike)} {right.upper()} — check the expiry date.")
            return close, day, high
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"{int(strike)} {right.upper()} close failed: {exc}")
            return None, None, None

    level_names = {0: "ATM", 1: "ATM+1", -1: "ATM-1"}
    levels = []
    for offset in (0, 1, -1):
        name = level_names[offset]
        center = atm + offset * SNIPER_STEP
        ce_strike = center + SNIPER_STEP
        pe_strike = center - SNIPER_STEP
        ce_close, ce_day, ce_high = option_close("call", ce_strike)
        pe_close, pe_day, pe_high = option_close("put", pe_strike)

        for label, day in (("CE", ce_day), ("PE", pe_day)):
            if day and nifty_close_date and day != nifty_close_date:
                warnings.append(f"{name}: {label} close is from {day} but NIFTY close is from {nifty_close_date}.")

        sniper_value = upper = lower = None
        if ce_close is not None and pe_close is not None:
            sniper_value = (ce_close + pe_close) / 2
            upper = center + sniper_value
            lower = center - sniper_value

        levels.append({
            "name": name,
            "center": center,
            "ce_strike": ce_strike,
            "pe_strike": pe_strike,
            "ce_close": ce_close,
            "pe_close": pe_close,
            "ce_high": ce_high,
            "pe_high": pe_high,
            "sniper_value": sniper_value,
            "upper_band": upper,
            "lower_band": lower,
        })

    atm_level = levels[0]
    return jsonify({
        "nifty_close": nifty_close,
        "nifty_close_date": nifty_close_date,
        "reference_price": nifty_close if nifty_close is not None else atm,
        "atm_auto": atm_auto,
        "atm": atm,
        "is_manual_atm": atm_override is not None and atm_override != atm_auto,
        "expiry_date": expiry_dt.strftime("%d-%b-%Y"),
        "levels": levels,
        # kept for backward compatibility (ATM level only)
        "ce_strike": atm_level["ce_strike"],
        "pe_strike": atm_level["pe_strike"],
        "ce_close": atm_level["ce_close"],
        "pe_close": atm_level["pe_close"],
        "sniper_value": atm_level["sniper_value"],
        "upper_band": atm_level["upper_band"],
        "lower_band": atm_level["lower_band"],
        "warnings": warnings,
    })


# ---------------------------------------------------------------------------
# Trading Bot — live quotes for the watchlist.
# READ-ONLY: the bot page is paper trading; nothing here (or in the paper-trade UI) places orders.
# ---------------------------------------------------------------------------

def _quote_row(resp):
    if not isinstance(resp, dict):
        return {}
    rows = resp.get("Success")
    row = rows[0] if isinstance(rows, list) and rows else rows
    return row if isinstance(row, dict) else {}


def _to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


@app.route("/api/bot/quotes", methods=["POST"])
def bot_quotes():
    """body: {"expiry": "YYYY-MM-DD", "contracts": [{"key": "...", "type": "spot|call|put", "strike": 22900}, ...]}"""
    err = require_session()
    if err:
        return err

    body = request.get_json(silent=True) or {}
    try:
        expiry_str = datetime.strptime(body.get("expiry"), "%Y-%m-%d").strftime("%d-%b-%Y")
    except (TypeError, ValueError):
        return jsonify({"error": "expiry must be in YYYY-MM-DD format"}), 400

    breeze = state["breeze"]
    out = []
    for c in (body.get("contracts") or [])[:12]:
        key, kind = c.get("key"), c.get("type")
        try:
            if kind == "spot":
                resp = breeze.get_quotes(stock_code="NIFTY", exchange_code="NSE", product_type="cash")
            elif kind in ("call", "put"):
                resp = breeze.get_quotes(
                    stock_code="NIFTY", exchange_code="NFO", expiry_date=expiry_str,
                    product_type="options", right="Call" if kind == "call" else "Put",
                    strike_price=str(int(float(c.get("strike")))),
                )
            else:
                out.append({"key": key, "error": "unknown contract type"})
                continue
            row = _quote_row(resp)
            if not row:
                reason = (resp.get("Error") if isinstance(resp, dict) else None) or "No quote returned by Breeze"
                out.append({"key": key, "error": str(reason)})
                continue
            out.append({
                "key": key,
                "ltp": _to_float(row.get("ltp")),
                "prev_close": _to_float(row.get("previous_close") or row.get("prev_close")),
            })
        except Exception as exc:  # noqa: BLE001 — one bad contract must not break the rest
            out.append({"key": key, "error": str(exc)})
    return jsonify({"quotes": out})


# ---------------------------------------------------------------------------
# REAL order placement for the Trading Bot.
#   * Switched on from the web page (Trading Bot switches 3 / 4 + typed REAL confirmation).
#     Needs a logged-in, paid user with a live Breeze session of their own.
#   * Options only (NIFTY / NFO), market or limit, quantity capped by BOT_MAX_REAL_QTY (exchange freeze limit).
#   * Every attempt (accepted or not) is appended to real_orders.log for audit.
# The paper-trading UI never calls these endpoints.
# ---------------------------------------------------------------------------
import json as _json

BOT_MAX_REAL_QTY = int(os.getenv("BOT_MAX_REAL_QTY", "1800"))  # NIFTY freeze quantity per order
REAL_ORDER_LOG = os.getenv("REAL_ORDER_LOG", "real_orders.log")
ORDER_EXPIRY_TIME = os.getenv("BREEZE_ORDER_EXPIRY_TIME_UTC", "06:00:00.000Z")


def _log_real_order(entry):
    try:
        with open(REAL_ORDER_LOG, "a", encoding="utf-8") as fh:
            who = g.user["username"] if getattr(g, "user", None) else None
            fh.write(_json.dumps({"at": datetime.now(IST).isoformat(), "user": who, **entry}, default=str) + "\n")
    except OSError:
        pass


@app.route("/api/bot/real-status", methods=["GET"])
def bot_real_status():
    return jsonify({"enabled": True, "max_qty": BOT_MAX_REAL_QTY})


@app.route("/api/bot/real-order", methods=["POST"])
def bot_real_order():
    """body: {"expiry": "YYYY-MM-DD", "right": "call|put", "strike": 22900, "action": "buy|sell",
              "quantity": 65, "order_type": "market|limit", "price": 0, "remark": "..."}"""
    err = require_session()
    if err:
        return err

    body = request.get_json(silent=True) or {}
    try:
        expiry_dt = datetime.strptime(body.get("expiry"), "%Y-%m-%d")
        right = str(body.get("right", "")).lower()
        action = str(body.get("action", "")).lower()
        order_type = str(body.get("order_type", "market")).lower()
        strike = int(float(body.get("strike")))
        qty = int(body.get("quantity"))
    except (TypeError, ValueError):
        return jsonify({"error": "invalid order fields"}), 400
    if right not in ("call", "put") or action not in ("buy", "sell") or order_type not in ("market", "limit"):
        return jsonify({"error": "right must be call|put, action buy|sell, order_type market|limit"}), 400
    if qty <= 0 or qty > BOT_MAX_REAL_QTY:
        return jsonify({"error": f"quantity must be between 1 and {BOT_MAX_REAL_QTY} (BOT_MAX_REAL_QTY)"}), 400
    price = "0"
    if order_type == "limit":
        try:
            if float(body.get("price")) <= 0:
                raise ValueError
            price = str(float(body.get("price")))
        except (TypeError, ValueError):
            return jsonify({"error": "limit orders need a positive price"}), 400

    audit = {"expiry": expiry_dt.strftime("%Y-%m-%d"), "right": right, "strike": strike, "action": action,
             "qty": qty, "order_type": order_type, "price": price, "remark": body.get("remark")}
    try:
        resp = state["breeze"].place_order(
            stock_code="NIFTY", exchange_code="NFO", product="options", action=action,
            order_type=order_type, stoploss="", quantity=str(qty), price=price,
            validity="day", validity_date=datetime.now(timezone.utc).strftime("%Y-%m-%dT") + ORDER_EXPIRY_TIME,
            disclosed_quantity="0",
            expiry_date=expiry_dt.strftime("%Y-%m-%dT") + ORDER_EXPIRY_TIME,
            right=right, strike_price=str(strike), user_remark=str(body.get("remark") or "bot")[:20],
        )
    except Exception as exc:  # noqa: BLE001
        _log_real_order({**audit, "result": "exception", "error": str(exc)})
        return jsonify({"ok": False, "error": str(exc)}), 502

    success = resp.get("Success") if isinstance(resp, dict) else None
    order_id = success.get("order_id") if isinstance(success, dict) else None
    reason = None if order_id else str((resp.get("Error") if isinstance(resp, dict) else None) or "Breeze did not return an order id")
    _log_real_order({**audit, "result": "accepted" if order_id else "rejected", "order_id": order_id, "error": reason, "raw": resp})
    return jsonify({
        "ok": bool(order_id),
        "order_id": order_id,
        "message": success.get("message") if isinstance(success, dict) else None,
        "error": reason,
    })


@app.route("/api/bot/order-status", methods=["GET"])
def bot_order_status():
    err = require_session()
    if err:
        return err
    order_id = request.args.get("order_id")
    if not order_id:
        return jsonify({"error": "order_id is required"}), 400
    try:
        resp = state["breeze"].get_order_detail(exchange_code="NFO", order_id=order_id)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 502
    rows = resp.get("Success") if isinstance(resp, dict) else None
    row = rows[0] if isinstance(rows, list) and rows else (rows if isinstance(rows, dict) else {})
    return jsonify({
        "status": row.get("status"),
        "avg_price": _to_float(row.get("average_price")),
        "quantity": row.get("quantity"),
        "pending_quantity": row.get("pending_quantity"),
    })


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "reset-admin":
        _cli_reset_admin()
        sys.exit(0)
    app.run(port=PORT, debug=True)
