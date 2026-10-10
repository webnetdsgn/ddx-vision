# -*- coding: utf-8 -*-
"""
DDX Vision Admin — отдельное приложение администраторов точки.

Это ЕДИНСТВЕННОЕ место, где можно увидеть живой кадр с камер. Обычное приложение посетителя видео
не получает вообще: оно видит только числа по зонам.

  - вход по логину и паролю; у каждой точки (каждого клуба) свой набор администраторов, пароли разные
  - пароли хранятся только в виде PBKDF2-хэша, файл admins.json закрыт от остальных пользователей Mac
  - блокировка перебора пароля, сессия с таймаутом бездействия, выход по кнопке
  - журнал: кто, когда и какую камеру смотрел (видео в журнал не попадает)
  - записи нет: показывается живой кадр, на диск ничего не пишется
  - области-маски (зеркала, окна, всё лишнее) в админке закрашены чёрным
  - по умолчанию слушает только этот компьютер (127.0.0.1); в сеть — только явным флагом
"""
from __future__ import annotations

import collections
import hashlib
import hmac
import json
import os
import re
import secrets
import ssl
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np

PBKDF2_ITER = 240000
USER_RE = re.compile(r"^[A-Za-z0-9._-]{3,32}$")
MIN_PASSWORD = 10
BOUNDARY = "ddxframe"
STATIC = {"/": "index.html", "/index.html": "index.html", "/admin.js": "admin.js", "/admin.css": "admin.css"}
STATIC_TYPES = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8"}
CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; "
       "base-uri 'none'; form-action 'self'; frame-ancestors 'none'")


def _pbkdf2(password: str, salt: bytes, iters: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iters)


# ================================================================ администраторы точки
class AdminStore:
    """admins.json: {"users": {"имя": {"salt": hex, "hash": hex, "iter": n, "created": ts}}}. Паролей в открытом виде нет."""

    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()
        self._dummy = (os.urandom(16), PBKDF2_ITER)

    def _load(self) -> dict:
        if not os.path.isfile(self.path):
            return {"users": {}}
        with open(self.path, encoding="utf-8") as f:
            data = json.load(f)
        data.setdefault("users", {})
        return data

    def _save(self, data: dict) -> None:
        tmp = self.path + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)  # читать может только владелец
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.path)
        os.chmod(self.path, 0o600)

    def users(self):
        with self._lock:
            return sorted(self._load()["users"])

    def add(self, user: str, password: str) -> None:
        if not USER_RE.match(user or ""):
            raise ValueError("логин: 3–32 символа, латиница, цифры, точка, дефис, подчёркивание")
        if len(password or "") < MIN_PASSWORD:
            raise ValueError("пароль должен быть не короче %d символов" % MIN_PASSWORD)
        salt = os.urandom(16)
        with self._lock:
            data = self._load()
            data["users"][user] = {"salt": salt.hex(), "hash": _pbkdf2(password, salt, PBKDF2_ITER).hex(), "iter": PBKDF2_ITER, "created": int(time.time())}
            self._save(data)

    def remove(self, user: str) -> bool:
        with self._lock:
            data = self._load()
            if user not in data["users"]:
                return False
            del data["users"][user]
            self._save(data)
            return True

    def verify(self, user: str, password: str) -> bool:
        with self._lock:
            rec = self._load()["users"].get(user or "")
        if rec is None:  # одинаковое время ответа для существующего и несуществующего логина
            _pbkdf2(password or "", self._dummy[0], self._dummy[1])
            return False
        got = _pbkdf2(password or "", bytes.fromhex(rec["salt"]), int(rec.get("iter", PBKDF2_ITER)))
        return hmac.compare_digest(got, bytes.fromhex(rec["hash"]))


# ================================================================ сессии, защита от перебора, журнал
class Sessions:
    def __init__(self, idle: float = 1800.0, absolute: float = 8 * 3600.0, clock=time.time):
        self.idle, self.absolute, self.clock = idle, absolute, clock
        self._s: dict[str, dict] = {}
        self._lock = threading.Lock()

    def create(self, user: str, ip: str) -> str:
        token = secrets.token_urlsafe(32)
        now = self.clock()
        with self._lock:
            self._s[token] = {"user": user, "ip": ip, "created": now, "last": now}
        return token

    def get(self, token, touch: bool = False):
        if not token:
            return None
        now = self.clock()
        with self._lock:
            s = self._s.get(token)
            if s is None:
                return None
            if now - s["created"] > self.absolute or now - s["last"] > self.idle:
                del self._s[token]
                return None
            if touch:
                s["last"] = now
            return dict(s)

    def idle_left(self, s: dict) -> int:
        return max(0, int(self.idle - (self.clock() - s["last"])))

    def destroy(self, token) -> None:
        with self._lock:
            self._s.pop(token, None)


class LoginGuard:
    """5 неудачных входов с одного адреса за 10 минут → пауза 5 минут; 10 по одному логину — тоже пауза."""

    def __init__(self, ip_fail: int = 5, user_fail: int = 10, window: float = 600.0, lock: float = 300.0, clock=time.time):
        self.ip_fail, self.user_fail, self.window, self.lock, self.clock = ip_fail, user_fail, window, lock, clock
        self._f: dict[tuple, list] = collections.defaultdict(list)
        self._until: dict[tuple, float] = {}
        self._mu = threading.Lock()

    def check(self, ip: str, user: str) -> int:
        now = self.clock()
        with self._mu:
            wait = max([self._until.get(k, 0) - now for k in (("ip", ip), ("user", (user or "").lower()))] + [0])
        return int(wait) + 1 if wait > 0 else 0

    def fail(self, ip: str, user: str) -> None:
        now = self.clock()
        with self._mu:
            for kind, key, limit in (("ip", ip, self.ip_fail), ("user", (user or "").lower(), self.user_fail)):
                k = (kind, key)
                self._f[k] = [t for t in self._f[k] if now - t < self.window] + [now]
                if len(self._f[k]) >= limit:
                    self._until[k] = now + self.lock
                    self._f[k] = []

    def ok(self, ip: str, user: str) -> None:
        with self._mu:
            self._f.pop(("ip", ip), None)
            self._f.pop(("user", (user or "").lower()), None)


class AuditLog:
    """Журнал доступа: время, событие, логин, адрес, камера. Видео и пароли сюда не попадают."""

    def __init__(self, path: str | None = None, clock=time.time):
        self.path, self.clock = path, clock
        self.mem = collections.deque(maxlen=500)
        self._mu = threading.Lock()

    def log(self, event: str, user: str = "", ip: str = "", **extra) -> None:
        rec = {"ts": int(self.clock()), "event": event, "user": user, "ip": ip}
        rec.update(extra)
        with self._mu:
            self.mem.append(rec)
            if self.path:
                try:
                    fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                    with os.fdopen(fd, "a", encoding="utf-8") as f:
                        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                except OSError:  # диск недоступен — событие всё равно остаётся в памяти и в окне «Журнал»
                    pass

    def recent(self, n: int = 50):
        with self._mu:
            return list(self.mem)[-n:][::-1]


# ================================================================ приложение
class AdminApp:
    def __init__(self, hub, store: AdminStore, audit: AuditLog, club_name: str, overlay_fn, static_dir: str,
                 tls: bool = False, idle: float = 1800.0, max_streams: int = 4, stream_fps: float = 5.0, clock=time.time):
        self.hub, self.store, self.audit, self.club_name, self.overlay_fn = hub, store, audit, club_name, overlay_fn
        self.static_dir, self.tls, self.max_streams, self.stream_fps = static_dir, tls, max_streams, stream_fps
        self.sessions = Sessions(idle=idle, clock=clock)
        self.guard = LoginGuard(clock=clock)
        self._streams = 0
        self._mu = threading.Lock()

    def camera(self, name: str):
        for c in self.hub.cameras:
            if c.name == name:
                return c
        return None

    def render_jpeg(self, cam, overlay: bool):
        """Живой кадр для администратора: маски закрашены чёрным, при желании поверх рамки и зоны ИИ. На диск не пишется."""
        frame, ts = cam.latest()
        if frame is None:
            return None, 0.0
        img = frame.copy()
        h, w = img.shape[:2]
        for m in cam.masks:
            pts = np.round(m * np.array([w, h])).astype(np.int32)
            cv2.fillPoly(img, [pts], (0, 0, 0))
        if overlay:
            self.overlay_fn(img, cam)
        if w > 960:
            img = cv2.resize(img, (960, int(h * 960 / w)))
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 70])
        return (buf.tobytes() if ok else None), ts

    def acquire_stream(self) -> bool:
        with self._mu:
            if self._streams >= self.max_streams:
                return False
            self._streams += 1
            return True

    def release_stream(self) -> None:
        with self._mu:
            self._streams = max(0, self._streams - 1)


def make_admin_handler(app: AdminApp):
    class Handler(BaseHTTPRequestHandler):
        server_version = "DDXAdmin/0.1"

        def log_message(self, fmt, *a):
            pass

        # --- служебное
        def _ip(self) -> str:
            return self.client_address[0]

        def _headers(self, ctype: str, length: int | None = None, extra=None, html: bool = False):
            self.send_header("Content-Type", ctype)
            if length is not None:
                self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            if html:
                self.send_header("Content-Security-Policy", CSP)
            for k, v in (extra or []):
                self.send_header(k, v)

        def _json(self, code: int, obj, extra=None):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self._headers("application/json; charset=utf-8", len(body), extra)
            self.end_headers()
            self.wfile.write(body)

        def _token(self):
            for part in (self.headers.get("Cookie") or "").split(";"):
                k, _, v = part.strip().partition("=")
                if k == "ddx_admin":
                    return v
            return None

        def _session(self, touch: bool = False):
            return app.sessions.get(self._token(), touch=touch)

        def _cookie(self, token: str, max_age: int):
            return ("Set-Cookie", "ddx_admin=%s; HttpOnly; SameSite=Strict; Path=/; Max-Age=%d%s" % (token, max_age, "; Secure" if app.tls else ""))

        def _same_origin_post(self) -> bool:
            if self.headers.get("X-DDX-Admin") != "1":
                return False
            origin = self.headers.get("Origin")
            if origin and urllib.parse.urlsplit(origin).netloc != (self.headers.get("Host") or ""):
                return False
            return True

        def _body(self):
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return None
            if n <= 0 or n > 4096:
                return None
            try:
                return json.loads(self.rfile.read(n).decode("utf-8"))
            except Exception:  # noqa: BLE001
                return None

        # --- методы
        def do_OPTIONS(self):
            self.send_response(405)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self):
            path = self.path.split("?")[0]
            if not self._same_origin_post():
                return self._json(403, {"error": "forbidden"})
            if path == "/api/login":
                data = self._body() or {}
                user, pwd = str(data.get("user", ""))[:64], str(data.get("password", ""))[:256]
                ip = self._ip()
                wait = app.guard.check(ip, user)
                if wait:
                    app.audit.log("login.blocked", user, ip)
                    return self._json(429, {"error": "Слишком много попыток. Подождите %d мин." % max(1, (wait + 59) // 60), "retryAfter": wait}, [("Retry-After", str(wait))])
                if app.store.verify(user, pwd):
                    app.guard.ok(ip, user)
                    token = app.sessions.create(user, ip)
                    app.audit.log("login.ok", user, ip)
                    return self._json(200, {"ok": True, "user": user}, [self._cookie(token, int(app.sessions.absolute))])
                app.guard.fail(ip, user)
                app.audit.log("login.fail", user, ip)
                return self._json(401, {"error": "Неверный логин или пароль"})
            if path == "/api/logout":
                s = self._session()
                if s:
                    app.audit.log("logout", s["user"], self._ip())
                app.sessions.destroy(self._token())
                return self._json(200, {"ok": True}, [self._cookie("", 0)])
            if path == "/api/ping":
                s = self._session(touch=True)
                return self._json(200 if s else 401, {"ok": bool(s), "idleLeftSec": app.sessions.idle_left(s) if s else 0})
            return self._json(404, {"error": "not found"})

        def do_GET(self):
            u = urllib.parse.urlsplit(self.path)
            path = u.path
            if path in STATIC:
                f = os.path.join(app.static_dir, STATIC[path])
                if not os.path.isfile(f):
                    return self._json(404, {"error": "not found"})
                with open(f, "rb") as fh:
                    body = fh.read()
                self.send_response(200)
                self._headers(STATIC_TYPES[os.path.splitext(f)[1]], len(body), html=f.endswith(".html"))
                self.end_headers()
                self.wfile.write(body)
                return
            if not path.startswith("/api/"):
                return self._json(404, {"error": "not found"})
            s = self._session()
            if not s:
                return self._json(401, {"error": "unauthorized"})
            if path == "/api/me":
                return self._json(200, {"user": s["user"], "club": app.club_name, "idleLeftSec": app.sessions.idle_left(s), "tls": app.tls, "recording": False})
            if path == "/api/cameras":
                out = []
                for c in app.hub.cameras:
                    out.append({"name": c.name, "state": "online" if c.online() else "offline", "size": list(c.shape[::-1]) if c.shape else None,
                                "zones": sorted({z["id"] for z in c.zones})})
                return self._json(200, {"cameras": out})
            if path == "/api/occupancy":
                return self._json(200, app.hub.snapshot())
            if path == "/api/audit":
                try:
                    n = max(1, min(200, int(urllib.parse.parse_qs(u.query).get("limit", ["50"])[0])))
                except ValueError:
                    n = 50
                return self._json(200, {"events": app.audit.recent(n)})
            m = re.match(r"^/api/cameras/([A-Za-z0-9._-]{1,40})/stream\.mjpg$", path)
            if m:
                return self._stream(m.group(1), parse_overlay(u.query))
            return self._json(404, {"error": "not found"})

        def _stream(self, name: str, overlay: bool):
            cam = app.camera(name)
            if cam is None:
                return self._json(404, {"error": "no such camera"})
            if not app.acquire_stream():
                return self._json(503, {"error": "слишком много одновременных просмотров"})
            token, ip = self._token(), self._ip()
            s = app.sessions.get(token)
            user = s["user"] if s else ""
            app.audit.log("view.start", user, ip, camera=name, overlay=overlay)
            try:
                self.send_response(200)
                self._headers("multipart/x-mixed-replace; boundary=" + BOUNDARY)
                self.end_headers()
                period = 1.0 / app.stream_fps
                while True:
                    if not app.sessions.get(token):  # вышел, истекла сессия — поток обрывается
                        break
                    jpg, _ts = app.render_jpeg(cam, overlay)
                    if jpg:  # шлём кадр каждый период: так быстро замечаем, что окно закрыли, и освобождаем место
                        self.wfile.write(("--%s\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % (BOUNDARY, len(jpg))).encode() + jpg + b"\r\n")
                        self.wfile.flush()
                    time.sleep(period)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                pass
            finally:
                app.release_stream()
                app.audit.log("view.end", user, ip, camera=name)

    return Handler


def parse_overlay(query: str) -> bool:
    return urllib.parse.parse_qs(query).get("overlay", ["0"])[0] == "1"


def make_admin_server(app: AdminApp, host: str, port: int, tls_files=None) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer((host, port), make_admin_handler(app))
    srv.daemon_threads = True
    if tls_files:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(tls_files[0], tls_files[1])
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    return srv
