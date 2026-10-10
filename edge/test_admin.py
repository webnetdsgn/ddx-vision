#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Проверки админ-приложения: видео видит только вошедший администратор точки.
Запуск:  python3 -m unittest -v test_admin      (из папки edge)"""
import http.client
import json
import os
import shutil
import ssl
import stat
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

import cv2
import numpy as np

import ddx_admin as A
import ddx_edge as E
from test_edge import FakeDetector, LEFT, RIGHT, cam_cfg, online_cam

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
PWD = "correct-horse-battery"


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class Passwords(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.store = A.AdminStore(os.path.join(self.dir, "admins.json"))

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_add_verify_and_no_plaintext(self):
        self.store.add("ivanov", PWD)
        self.assertTrue(self.store.verify("ivanov", PWD))
        self.assertFalse(self.store.verify("ivanov", PWD + "x"))
        self.assertFalse(self.store.verify("nobody", PWD))
        raw = open(self.store.path, encoding="utf-8").read()
        self.assertNotIn(PWD, raw)
        self.assertIn("salt", raw)

    def test_file_is_private(self):
        self.store.add("ivanov", PWD)
        self.assertEqual(stat.S_IMODE(os.stat(self.store.path).st_mode), 0o600)

    def test_weak_password_and_bad_login_are_rejected(self):
        with self.assertRaises(ValueError):
            self.store.add("ivanov", "short")
        for bad in ("a", "ab", "with space", "кириллица", "x" * 40, ""):
            with self.assertRaises(ValueError):
                self.store.add(bad, PWD)

    def test_two_points_have_independent_accounts(self):
        other = A.AdminStore(os.path.join(self.dir, "other.json"))
        self.store.add("manager", PWD)
        other.add("manager", "another-password-9")
        self.assertTrue(self.store.verify("manager", PWD))
        self.assertFalse(other.verify("manager", PWD))  # пароль одной точки не подходит другой
        self.assertTrue(other.verify("manager", "another-password-9"))

    def test_remove(self):
        self.store.add("ivanov", PWD)
        self.assertTrue(self.store.remove("ivanov"))
        self.assertFalse(self.store.verify("ivanov", PWD))
        self.assertFalse(self.store.remove("ivanov"))


class SessionsGuardAudit(unittest.TestCase):
    def test_idle_and_absolute_expiry(self):
        clk = FakeClock()
        s = A.Sessions(idle=100, absolute=1000, clock=clk)
        tok = s.create("u", "1.1.1.1")
        clk.t += 60
        self.assertIsNotNone(s.get(tok))           # просмотр без touch не продлевает
        clk.t += 50
        self.assertIsNone(s.get(tok))              # 110 с без активности — сессии нет
        tok = s.create("u", "1.1.1.1")
        for _ in range(8):
            clk.t += 90
            self.assertIsNotNone(s.get(tok, touch=True))
        clk.t += 400
        self.assertIsNone(s.get(tok, touch=True))  # абсолютный предел

    def test_tokens_are_unpredictable(self):
        s = A.Sessions()
        self.assertEqual(len({s.create("u", "ip") for _ in range(50)}), 50)

    def test_lockout_after_failures_and_reset(self):
        clk = FakeClock()
        g = A.LoginGuard(clock=clk)
        for _ in range(4):
            g.fail("9.9.9.9", "ivanov")
        self.assertEqual(g.check("9.9.9.9", "ivanov"), 0)
        g.fail("9.9.9.9", "ivanov")
        self.assertGreater(g.check("9.9.9.9", "ivanov"), 0)
        self.assertEqual(g.check("8.8.8.8", "other"), 0)   # чужой адрес не страдает
        clk.t += 301
        self.assertEqual(g.check("9.9.9.9", "ivanov"), 0)  # пауза закончилась
        g.fail("9.9.9.9", "ivanov")
        g.ok("9.9.9.9", "ivanov")
        for _ in range(4):
            g.fail("9.9.9.9", "ivanov")
        self.assertEqual(g.check("9.9.9.9", "ivanov"), 0)

    def test_audit_log_is_private_and_has_no_secrets(self):
        d = tempfile.mkdtemp()
        try:
            log = A.AuditLog(os.path.join(d, "audit.log"))
            log.log("login.ok", "ivanov", "10.0.0.5")
            log.log("view.start", "ivanov", "10.0.0.5", camera="cam1")
            self.assertEqual(log.recent(1)[0]["event"], "view.start")
            self.assertEqual(stat.S_IMODE(os.stat(os.path.join(d, "audit.log")).st_mode), 0o600)
            lines = open(os.path.join(d, "audit.log"), encoding="utf-8").read().splitlines()
            self.assertEqual(len(lines), 2)
            self.assertEqual(json.loads(lines[1])["camera"], "cam1")
        finally:
            shutil.rmtree(d, ignore_errors=True)


def scene_cam(name="cam1"):
    """Камера с настоящим кадром: серый фон, яркий красный квадрат в левой части и маска справа внизу."""
    cam = online_cam([{"id": "chest", "capacity": 4, "polygon": LEFT}, {"id": "cardio", "capacity": 3, "polygon": RIGHT}], [1, 0], name)
    cam.masks = [np.array([[0.6, 0.6], [1.0, 0.6], [1.0, 1.0], [0.6, 1.0]], np.float32)]
    frame = np.full((480, 640, 3), 140, np.uint8)
    frame[100:200, 60:160] = (0, 0, 255)
    cam.frame, cam.frame_ts, cam.shape = frame, time.time(), (480, 640)
    cam.last = {"ts": time.time(), "boxes": [(60, 100, 160, 300, 0.9)], "feet": [(0.17, 0.62, "chest#0")], "raw": {}, "fps": 2.0}
    return cam


class StreamHandle:
    """У ответов HTTP/1.0 сокет принадлежит самому ответу, поэтому закрывать нужно оба."""

    def __init__(self, conn, resp):
        self.conn, self.resp = conn, resp

    def close(self):
        self.resp.close()
        self.conn.close()


class Client:
    """Мини-клиент с cookie для проверки HTTP."""

    def __init__(self, port, tls=False):
        self.port, self.tls, self.cookie = port, tls, None

    def conn(self):
        if self.tls:
            ctx = ssl.create_default_context()
            ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE
            return http.client.HTTPSConnection("127.0.0.1", self.port, timeout=8, context=ctx)
        return http.client.HTTPConnection("127.0.0.1", self.port, timeout=8)

    def req(self, method, path, body=None, headers=None, csrf=True, read=True):
        h = dict(headers or {})
        if self.cookie:
            h["Cookie"] = "ddx_admin=" + self.cookie
        if method == "POST" and csrf:
            h.setdefault("X-DDX-Admin", "1")
            h.setdefault("Content-Type", "application/json")
        c = self.conn()
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers=h)
        r = c.getresponse()
        if not read:
            return StreamHandle(c, r), r
        data = r.read()
        c.close()
        return r, data

    def login(self, user="ivanov", pwd=PWD):
        r, data = self.req("POST", "/api/login", {"user": user, "password": pwd})
        sc = r.getheader("Set-Cookie") or ""
        if r.status == 200 and sc.startswith("ddx_admin="):
            self.cookie = sc.split(";")[0].split("=", 1)[1]
        return r, json.loads(data or b"{}"), sc


def read_part(resp):
    """Читает одну часть multipart/x-mixed-replace и возвращает байты JPEG."""
    line = resp.fp.readline()
    while line.strip() == b"":
        line = resp.fp.readline()
    assert line.strip() == b"--ddxframe", line
    length = None
    while True:
        h = resp.fp.readline().strip()
        if not h:
            break
        if h.lower().startswith(b"content-length"):
            length = int(h.split(b":")[1])
    return resp.fp.read(length)


class AdminHttp(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        cls.store = A.AdminStore(os.path.join(cls.dir, "admins.json"))
        cls.store.add("ivanov", PWD)
        cls.audit = A.AuditLog(os.path.join(cls.dir, "audit.log"))
        cls.hub = E.Hub({"clubName": "Точка Тест"}, [scene_cam()], FakeDetector([]))
        cls.app = A.AdminApp(cls.hub, cls.store, cls.audit, "Точка Тест", E.draw_overlay, os.path.join(HERE, "admin"), max_streams=2, stream_fps=20)
        cls.srv = A.make_admin_server(cls.app, "127.0.0.1", 0)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.port = cls.srv.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        shutil.rmtree(cls.dir, ignore_errors=True)

    def setUp(self):
        self.app.guard = A.LoginGuard()  # у каждого теста чистый счётчик неудач

    # ---- без входа ничего нельзя
    def test_anonymous_gets_nothing(self):
        c = Client(self.port)
        for p in ("/api/me", "/api/cameras", "/api/occupancy", "/api/audit", "/api/cameras/cam1/stream.mjpg"):
            r, _ = c.req("GET", p)
            self.assertEqual(r.status, 401, p)
        r, _ = c.req("GET", "/api/cameras/cam1/stream.mjpg?overlay=1", headers={"Cookie": "ddx_admin=forged-token"})
        self.assertEqual(r.status, 401)

    def test_login_page_is_public_but_strict(self):
        r, body = Client(self.port).req("GET", "/")
        self.assertEqual(r.status, 200)
        self.assertIn(b"DDX Vision Admin", body)
        csp = r.getheader("Content-Security-Policy")
        self.assertIn("script-src 'self'", csp)
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertEqual(r.getheader("X-Frame-Options"), "DENY")
        self.assertEqual(r.getheader("Cache-Control"), "no-store")
        self.assertNotIn(b"<script>", body.replace(b'<script src="admin.js"></script>', b""))  # нет inline-кода
        self.assertIsNone(r.getheader("Access-Control-Allow-Origin"))                          # другие сайты не читают

    def test_other_files_are_not_served(self):
        c = Client(self.port)
        for p in ("/admins.json", "/audit.log", "/ddx_admin.py", "/../ddx_edge.py", "/admin/index.html", "/%2e%2e/admins.json", "/config.json", "/api"):
            r, _ = c.req("GET", p)
            self.assertIn(r.status, (401, 404), p)

    # ---- вход
    def test_csrf_and_origin_checks(self):
        c = Client(self.port)
        r, _ = c.req("POST", "/api/login", {"user": "ivanov", "password": PWD}, csrf=False, headers={"Content-Type": "application/json"})
        self.assertEqual(r.status, 403)
        r, _ = c.req("POST", "/api/login", {"user": "ivanov", "password": PWD}, headers={"Origin": "https://evil.example"})
        self.assertEqual(r.status, 403)
        r, _, _ = c.login()
        self.assertEqual(r.status, 200)

    def test_wrong_password_is_generic_and_logged(self):
        c = Client(self.port)
        r1, j1, _ = c.login("ivanov", "wrong-password-1")
        r2, j2, _ = c.login("nobody", "wrong-password-2")
        self.assertEqual((r1.status, r2.status), (401, 401))
        self.assertEqual(j1["error"], j2["error"])  # нельзя понять, есть ли такой логин
        self.assertIn("login.fail", [e["event"] for e in self.audit.recent(5)])

    def test_bruteforce_is_blocked(self):
        c = Client(self.port)
        for _ in range(5):
            c.login("ivanov", "wrong-password-x")
        r, j, _ = c.login("ivanov", PWD)  # даже верный пароль в паузе не принимается
        self.assertEqual(r.status, 429)
        self.assertIn("Подождите", j["error"])
        self.assertIsNotNone(r.getheader("Retry-After"))

    def test_cookie_flags_and_session_api(self):
        c = Client(self.port)
        r, j, sc = c.login()
        self.assertEqual(r.status, 200)
        self.assertIn("HttpOnly", sc)
        self.assertIn("SameSite=Strict", sc)
        self.assertNotIn("Secure", sc)  # по http Secure нельзя; с TLS — проверяется отдельно
        r, data = c.req("GET", "/api/me")
        me = json.loads(data)
        self.assertEqual((r.status, me["user"], me["club"], me["recording"]), (200, "ivanov", "Точка Тест", False))
        r, data = c.req("GET", "/api/cameras")
        self.assertEqual(json.loads(data)["cameras"][0]["name"], "cam1")
        r, data = c.req("GET", "/api/occupancy")
        self.assertEqual(r.status, 200)
        self.assertEqual(json.loads(data)["zones"][0]["id"], "chest")

    # ---- видео
    def test_stream_shows_live_frame_with_masks_black(self):
        c = Client(self.port)
        c.login()
        conn, resp = c.req("GET", "/api/cameras/cam1/stream.mjpg?overlay=0", read=False)
        self.assertEqual(resp.status, 200)
        self.assertIn("multipart/x-mixed-replace", resp.getheader("Content-Type"))
        jpg = read_part(resp)
        conn.close()
        self.assertEqual(jpg[:2], b"\xff\xd8")
        img = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(img.shape[:2], (480, 640))
        self.assertGreater(int(img[150, 110][2]), 200)          # красный квадрат виден — это живой кадр
        self.assertLess(int(img[400, 500].max()), 25)           # маска закрашена чёрным
        self.assertGreater(int(img[100, 300].min()), 100)       # без рамок: серый фон без линий зоны

    def test_overlay_draws_zones_and_boxes(self):
        c = Client(self.port)
        c.login()
        frames = []
        for ov in (0, 1):
            conn, resp = c.req("GET", "/api/cameras/cam1/stream.mjpg?overlay=%d" % ov, read=False)
            frames.append(cv2.imdecode(np.frombuffer(read_part(resp), np.uint8), cv2.IMREAD_COLOR))
            conn.close()
        self.assertGreater(int(np.abs(frames[0].astype(int) - frames[1].astype(int)).sum()), 5000)

    def test_view_is_audited_including_end(self):
        c = Client(self.port)
        c.login()
        conn, resp = c.req("GET", "/api/cameras/cam1/stream.mjpg", read=False)
        read_part(resp)
        self.assertEqual(self.audit.recent(1)[0]["event"], "view.start")
        conn.close()
        for _ in range(40):
            if self.audit.recent(1)[0]["event"] == "view.end":
                break
            time.sleep(0.1)
        last = self.audit.recent(1)[0]
        self.assertEqual((last["event"], last["user"], last["camera"]), ("view.end", "ivanov", "cam1"))

    def test_unknown_camera_and_stream_limit(self):
        c = Client(self.port)
        c.login()
        r, _ = c.req("GET", "/api/cameras/nope/stream.mjpg")
        self.assertEqual(r.status, 404)
        r, _ = c.req("GET", "/api/cameras/..%2Fx/stream.mjpg")
        self.assertEqual(r.status, 404)
        opened = []
        try:
            for _ in range(2):
                conn, resp = c.req("GET", "/api/cameras/cam1/stream.mjpg", read=False)
                self.assertEqual(resp.status, 200)
                read_part(resp)
                opened.append(conn)
            r, _ = c.req("GET", "/api/cameras/cam1/stream.mjpg")
            self.assertEqual(r.status, 503)
        finally:
            for conn in opened:
                conn.close()
            time.sleep(0.6)

    def test_logout_ends_stream_and_session(self):
        c = Client(self.port)
        c.login()
        conn, resp = c.req("GET", "/api/cameras/cam1/stream.mjpg", read=False)
        read_part(resp)
        r, _ = c.req("POST", "/api/logout", {})
        self.assertEqual(r.status, 200)
        self.assertIn("Max-Age=0", r.getheader("Set-Cookie"))
        end = time.time() + 6
        closed = False
        while time.time() < end:  # поток должен оборваться сам
            try:
                if not resp.fp.read(4096):
                    closed = True
                    break
            except Exception:  # noqa: BLE001
                closed = True
                break
        conn.close()
        self.assertTrue(closed, "после выхода поток продолжал идти")
        old = c.cookie
        r, _ = c.req("GET", "/api/me", headers={"Cookie": "ddx_admin=" + old})
        self.assertEqual(r.status, 401)

    def test_session_expires_when_idle(self):
        clk = FakeClock()
        app = A.AdminApp(self.hub, self.store, A.AuditLog(), "T", E.draw_overlay, os.path.join(HERE, "admin"), idle=60, clock=clk)
        srv = A.make_admin_server(app, "127.0.0.1", 0)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            c = Client(srv.server_address[1])
            c.login()
            self.assertEqual(c.req("GET", "/api/me")[0].status, 200)
            clk.t += 61
            self.assertEqual(c.req("GET", "/api/me")[0].status, 401)
            c2 = Client(srv.server_address[1])
            c2.login()
            clk.t += 50
            self.assertEqual(c2.req("POST", "/api/ping", {})[0].status, 200)  # действие продлило сессию
            clk.t += 50
            self.assertEqual(c2.req("GET", "/api/me")[0].status, 200)
        finally:
            srv.shutdown()
            srv.server_close()

    @unittest.skipUnless(shutil.which("openssl"), "нет openssl")
    def test_tls_mode_sets_secure_cookie(self):
        d = tempfile.mkdtemp()
        try:
            crt, key = os.path.join(d, "c.pem"), os.path.join(d, "k.pem")
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "2", "-subj", "/CN=localhost"],
                           check=True, capture_output=True)
            app = A.AdminApp(self.hub, self.store, A.AuditLog(), "T", E.draw_overlay, os.path.join(HERE, "admin"), tls=True)
            srv = A.make_admin_server(app, "127.0.0.1", 0, (crt, key))
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            try:
                c = Client(srv.server_address[1], tls=True)
                r, j, sc = c.login()
                self.assertEqual(r.status, 200)
                self.assertIn("Secure", sc)
                self.assertEqual(c.req("GET", "/api/me")[0].status, 200)
            finally:
                srv.shutdown()
                srv.server_close()
        finally:
            shutil.rmtree(d, ignore_errors=True)


class MemberAppSeesNoVideo(unittest.TestCase):
    """Обычное приложение (порт посетителей) видео не получает ни при каких запросах."""

    @classmethod
    def setUpClass(cls):
        E.HUB = E.Hub({"clubId": "t", "clubName": "T"}, [scene_cam()], FakeDetector([]))
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), E.make_handler({"token": ""}, ROOT))
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.port = cls.srv.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def get(self, p):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", p)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r, data

    def test_admin_and_video_routes_do_not_exist_on_member_port(self):
        for p in ("/admin/", "/admin/index.html", "/api/cameras", "/api/cameras/cam1/stream.mjpg", "/stream.mjpg", "/snapshot.jpg", "/v1/cameras",
                  "/v1/stream", "/v1/snapshot", "/edge/admin/admin.js", "/edge/ddx_admin.py"):
            r, _ = self.get(p)
            self.assertEqual(r.status, 404, p)

    def test_no_member_endpoint_returns_images_or_cookies(self):
        for p in ("/", "/v1/occupancy", "/v1/equipment", "/v1/health", "/ai/core.js", "/index.html"):
            r, _ = self.get(p)
            ctype = r.getheader("Content-Type") or ""
            self.assertFalse(ctype.startswith("image/") or "multipart" in ctype, p + " → " + ctype)
            self.assertIsNone(r.getheader("Set-Cookie"), p)

    def test_source_separation(self):
        edge = open(os.path.join(HERE, "ddx_edge.py"), encoding="utf-8").read()
        adm = open(os.path.join(HERE, "ddx_admin.py"), encoding="utf-8").read()
        for word in ("imencode", "imwrite", "VideoWriter", "multipart/x-mixed-replace", "stream.mjpg"):
            self.assertNotIn(word, edge, "в коде для посетителей не должно быть видео: " + word)
        for word in ("imwrite", "VideoWriter"):
            self.assertNotIn(word, adm, "админ-приложение не должно записывать видео: " + word)


class AdminCli(unittest.TestCase):
    def test_add_list_remove_via_cli(self):
        d = tempfile.mkdtemp()
        old = E.ADMINS_FILE
        E.ADMINS_FILE = os.path.join(d, "admins.json")
        os.environ["DDX_TEST_PW"] = PWD
        try:
            self.assertEqual(E.main(["--add-admin", "ivanov", "--password-env", "DDX_TEST_PW"]), 0)
            self.assertEqual(E.main(["--add-admin", "petrov", "--password-env", "NO_SUCH_VAR"]), 1)  # пустой пароль не принимается
            self.assertEqual(A.AdminStore(E.ADMINS_FILE).users(), ["ivanov"])
            self.assertEqual(E.main(["--list-admins"]), 0)
            self.assertEqual(E.main(["--remove-admin", "ivanov"]), 0)
            self.assertEqual(A.AdminStore(E.ADMINS_FILE).users(), [])
        finally:
            E.ADMINS_FILE = old
            os.environ.pop("DDX_TEST_PW", None)
            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
