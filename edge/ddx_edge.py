#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DDX Vision Edge — прототип «мини-компьютера в клубе».

Видео с камеры  →  силуэты людей (лица НЕ распознаются)  →  числа по зонам  →  /v1/occupancy
Кадры никуда не сохраняются и не отправляются: из программы выходят только числа.

Запуск (подробности — в INSTRUCTION-RU.txt):
    python3 ddx_edge.py --download-model        # один раз: скачать модель
    python3 ddx_edge.py --preview               # проба: камера MacBook, окно с рамками
    python3 ddx_edge.py                         # сервер: http://localhost:8787/#live
"""
from __future__ import annotations

import argparse
import collections
import getpass
import hashlib
import hmac
import json
import math
import os
import posixpath
import signal
import socket
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# RTSP по TCP стабильнее, чем по UDP. Переменная должна быть задана до импорта cv2.
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")

import numpy as np  # noqa: E402
import cv2  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- зоны приложения
# id зон совпадают с ai/core.js (ZDEF). «locker» (раздевалки) намеренно запрещена:
# внутри раздевалок аналитику не делаем вообще.
ZONE_IDS = ("free", "legs", "chest", "back", "cardio", "func", "stretch", "group", "entrance")
FORBIDDEN_ZONES = {"locker": "раздевалки и зоны переодевания не анализируются — это сознательное решение"}

# ---------------------------------------------------------------- модели
MODELS = {
    "tiny": {
        "file": "yolox_tiny.onnx", "size": 416,
        "url": "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx",
        "sha256": "427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7",
    },
    "s": {
        "file": "yolox_s.onnx", "size": 640,
        "url": "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx",
        "sha256": "c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063",
    },
}

DEFAULT_CONFIG = {
    "clubId": "proto",
    "clubName": "DDX Vision — прототип",
    "port": 8787,
    "token": "",
    "fps": 2.0,
    "conf": 0.40,
    "model": "tiny",
    "smoothing": 5,
    "cameras": [
        {
            "name": "cam1",
            "source": "0",
            "masks": [],
            "zones": [
                # для проверки дома вместимость маленькая: 3 человека = зона заполнена
                {"id": "chest", "capacity": 3, "polygon": [[0, 0], [0.5, 0], [0.5, 1], [0, 1]]},
                {"id": "cardio", "capacity": 3, "polygon": [[0.5, 0], [1, 0], [1, 1], [0.5, 1]]},
            ],
        }
    ],
}


def log(msg: str) -> None:
    print("[%s] %s" % (time.strftime("%H:%M:%S"), msg), flush=True)


def mask_url(url: str) -> str:
    """Прячет логин и пароль в адресе камеры, чтобы они не попадали в вывод."""
    try:
        p = urllib.parse.urlsplit(url)
        if p.username or p.password:
            host = p.hostname or ""
            if p.port:
                host += ":%d" % p.port
            return urllib.parse.urlunsplit((p.scheme, "***@" + host, p.path, p.query, p.fragment))
    except Exception:
        pass
    return url


# ================================================================ геометрия
def point_in_polygon(x: float, y: float, poly) -> bool:
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


# ================================================================ детекторы людей
class YoloxDetector:
    """YOLOX (Apache-2.0) через OpenCV DNN. Ищет только класс «person» — силуэт, не лицо."""
    name = "yolox"

    def __init__(self, model_path: str, size: int | None = None, conf: float = 0.4, nms: float = 0.45):
        if not os.path.isfile(model_path):
            raise FileNotFoundError("Нет файла модели %s. Выполните: python3 ddx_edge.py --download-model" % model_path)
        self.net = cv2.dnn.readNetFromONNX(model_path)
        self.conf, self.nms = conf, nms
        base = os.path.basename(model_path).lower()
        guess = [416, 640] if ("tiny" in base or "nano" in base) else [640, 416]
        sizes = [size] if size else guess
        self.size = None
        last = None
        for s in sizes:
            try:
                blank = np.full((s, s, 3), 114, np.uint8)
                self.net.setInput(cv2.dnn.blobFromImage(blank, 1.0, (s, s), swapRB=False))
                out = self.net.forward()
                if out.ndim == 3 and out.shape[1] == self._anchors(s):
                    self.size = s
                    break
            except Exception as e:  # размер входа не подошёл — пробуем следующий
                last = e
        if self.size is None:
            raise RuntimeError("Не удалось запустить модель (%s)" % (last or "неожиданный формат выхода"))
        self.grid, self.stride = self._grids(self.size)

    @staticmethod
    def _anchors(s: int) -> int:
        return sum((s // st) ** 2 for st in (8, 16, 32))

    @staticmethod
    def _grids(s: int):
        grids, strides = [], []
        for st in (8, 16, 32):
            h = w = s // st
            xv, yv = np.meshgrid(np.arange(w), np.arange(h))
            g = np.stack((xv, yv), 2).reshape(-1, 2)
            grids.append(g)
            strides.append(np.full((g.shape[0], 1), st))
        return np.concatenate(grids, 0).astype(np.float32), np.concatenate(strides, 0).astype(np.float32)

    def decode(self, raw: np.ndarray, r: float, w: int, h: int):
        """raw: (N, 85) — выход модели. Возвращает [(x1, y1, x2, y2, score)] в пикселях исходного кадра."""
        p = raw
        score = p[:, 4] * p[:, 5]  # уверенность «объект» × вероятность класса person (индекс 0)
        keep = score >= self.conf
        if not keep.any():
            return []
        p, score, grid, stride = p[keep], score[keep], self.grid[keep], self.stride[keep]
        xy = (p[:, 0:2] + grid) * stride
        wh = np.exp(p[:, 2:4]) * stride
        x1y1 = (xy - wh / 2) / r
        x2y2 = (xy + wh / 2) / r
        boxes = np.concatenate([x1y1, x2y2], 1)
        boxes[:, 0::2] = np.clip(boxes[:, 0::2], 0, w - 1)
        boxes[:, 1::2] = np.clip(boxes[:, 1::2], 0, h - 1)
        xywh = [[float(b[0]), float(b[1]), float(b[2] - b[0]), float(b[3] - b[1])] for b in boxes]
        idx = cv2.dnn.NMSBoxes(xywh, [float(s) for s in score], self.conf, self.nms)
        idx = np.array(idx).reshape(-1) if len(idx) else []
        return [(float(boxes[i][0]), float(boxes[i][1]), float(boxes[i][2]), float(boxes[i][3]), float(score[i])) for i in idx]

    def detect(self, img):
        h, w = img.shape[:2]
        s = self.size
        r = min(s / h, s / w)
        nw, nh = max(1, int(w * r)), max(1, int(h * r))
        padded = np.full((s, s, 3), 114, np.uint8)
        padded[:nh, :nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
        self.net.setInput(cv2.dnn.blobFromImage(padded, 1.0, (s, s), swapRB=False))  # BGR, 0..255 — как требует YOLOX
        out = self.net.forward()
        return self.decode(out.reshape(-1, out.shape[-1]), r, w, h)


class HogDetector:
    """Запасной вариант без скачивания модели (встроен в OpenCV). Точность заметно ниже."""
    name = "hog"

    def __init__(self, conf: float = 0.4):
        self.hog = cv2.HOGDescriptor()
        self.hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
        self.conf = conf

    def detect(self, img):
        h, w = img.shape[:2]
        k = 640.0 / w if w > 640 else 1.0
        small = cv2.resize(img, (int(w * k), int(h * k))) if k != 1.0 else img
        rects, weights = self.hog.detectMultiScale(small, winStride=(8, 8), padding=(8, 8), scale=1.05)
        res = []
        for (x, y, rw, rh), wt in zip(rects, np.array(weights).reshape(-1)):
            if wt >= max(0.5, self.conf):
                res.append((x / k, y / k, (x + rw) / k, (y + rh) / k, float(wt)))
        return res


def build_detector(cfg: dict, args) -> object:
    name = args.detector or "yolox"
    conf = float(cfg.get("conf", 0.4))
    if name == "hog":
        return HogDetector(conf)
    model = cfg.get("model", "tiny")
    path = model if os.path.isfile(model) else os.path.join(HERE, "models", MODELS.get(model, {}).get("file", model))
    return YoloxDetector(path, conf=conf)


# ================================================================ временные треки (только для «времени в зоне»)
class Tracker:
    """Склеивает точки соседних кадров во временные номера «человек 1, 2…».
    Живёт только в памяти, номера не показываются наружу, через TTL забываются.
    Нужен лишь для оценки времени пребывания в зоне."""

    def __init__(self, max_dist: float = 0.12, ttl: float = 3.0, keep_visits_s: float = 3600.0):
        self.max_dist, self.ttl, self.keep = max_dist, ttl, keep_visits_s
        self.tracks: dict[int, dict] = {}
        self.next_id = 1
        self.visits: dict[str, collections.deque] = collections.defaultdict(collections.deque)  # зона → (когда, длительность с)

    def _close(self, tr, now):
        if tr["zone"] and now - tr["since"] >= 2.0:
            self.visits[tr["zone"]].append((now, now - tr["since"]))

    def update(self, points, now: float):
        """points: [(x, y, zone_id|None)] в долях кадра."""
        pairs = []
        for ti, tr in self.tracks.items():
            for pi, (x, y, _z) in enumerate(points):
                d = math.hypot(tr["x"] - x, tr["y"] - y)
                if d <= self.max_dist:
                    pairs.append((d, ti, pi))
        pairs.sort()
        used_t, used_p = set(), set()
        for _d, ti, pi in pairs:
            if ti in used_t or pi in used_p:
                continue
            used_t.add(ti)
            used_p.add(pi)
            tr, (x, y, z) = self.tracks[ti], points[pi]
            tr["x"], tr["y"], tr["last"] = x, y, now
            if z != tr["zone"]:
                self._close(tr, now)
                tr["zone"], tr["since"] = z, now
        for pi, (x, y, z) in enumerate(points):
            if pi not in used_p:
                self.tracks[self.next_id] = {"x": x, "y": y, "last": now, "zone": z, "since": now}
                self.next_id += 1
        for ti in [t for t, tr in self.tracks.items() if now - tr["last"] > self.ttl]:
            self._close(self.tracks[ti], now)
            del self.tracks[ti]
        for dq in self.visits.values():
            while dq and now - dq[0][0] > self.keep:
                dq.popleft()

    def dwell_min(self, zone: str, now: float) -> float:
        dq = self.visits.get(zone)
        if dq and len(dq) >= 3:
            return sum(d for _t, d in dq) / len(dq) / 60.0
        cur = [now - tr["since"] for tr in self.tracks.values() if tr["zone"] == zone]
        return (sum(cur) / len(cur) / 60.0) if cur else 0.0


# ================================================================ камера
def build_source(src):
    """Источник: число (камера Mac), путь к файлу, rtsp:// адрес или объект {url, user, password}."""
    if isinstance(src, dict):
        url = src.get("url", "")
        user, pwd = src.get("user"), src.get("password")
        if user:
            p = urllib.parse.urlsplit(url)
            host = p.hostname or ""
            if p.port:
                host += ":%d" % p.port
            cred = urllib.parse.quote(user, safe="") + (":" + urllib.parse.quote(pwd or "", safe="") if pwd is not None else "")
            url = urllib.parse.urlunsplit((p.scheme, cred + "@" + host, p.path, p.query, p.fragment))
        return url
    s = str(src).strip()
    return int(s) if s.isdigit() else s


class Camera:
    def __init__(self, cfg: dict, fps: float, smoothing: int):
        self.name = cfg.get("name", "cam")
        self.source = build_source(cfg.get("source", "0"))
        self.is_file = isinstance(self.source, str) and os.path.isfile(self.source)
        self.zones = cfg.get("zones", [])
        self.masks = [np.array(m, np.float32) for m in cfg.get("masks", [])]
        self.fps, self.smoothing = fps, max(1, smoothing)
        self.cap = None
        self.lock = threading.Lock()
        self.frame, self.frame_ts = None, 0.0
        self.state, self.error = "connecting", ""
        self.stop = threading.Event()
        self.shape = None  # (h, w) последнего кадра
        # результаты анализа
        self.hist = {z["id"] + "#%d" % i: collections.deque(maxlen=self.smoothing) for i, z in enumerate(self.zones)}
        self.tracker = Tracker()
        self.last = {"ts": 0.0, "boxes": [], "feet": [], "raw": {}, "fps": 0.0}
        self.persons_total = 0

    # --- открытие (первый раз — в главном потоке, чтобы macOS спросила доступ к камере)
    def open(self) -> bool:
        try:
            if self.cap is not None:
                self.cap.release()
            if isinstance(self.source, str) and self.source.startswith("rtsp"):
                try:
                    self.cap = cv2.VideoCapture(self.source, cv2.CAP_FFMPEG, [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 8000, cv2.CAP_PROP_READ_TIMEOUT_MSEC, 8000])
                except TypeError:
                    self.cap = cv2.VideoCapture(self.source, cv2.CAP_FFMPEG)
            else:
                self.cap = cv2.VideoCapture(self.source)
            ok = bool(self.cap.isOpened())
            self.state = "connecting" if ok else "offline"
            self.error = "" if ok else "не удалось открыть источник"
            return ok
        except Exception as e:  # noqa: BLE001
            self.state, self.error = "offline", str(e)
            return False

    def start(self):
        threading.Thread(target=self._reader, name="read-" + self.name, daemon=True).start()
        threading.Thread(target=self._analyzer, name="ai-" + self.name, daemon=True).start()

    def _reader(self):
        delay = 1.0
        while not self.stop.is_set():
            if self.cap is None or not self.cap.isOpened():
                if not self.open():
                    time.sleep(min(delay, 10.0))
                    delay *= 1.7
                    continue
                delay = 1.0
            t0 = time.time()
            ok, frame = self.cap.read()
            if not ok or frame is None:
                if self.is_file:  # файл закончился — играем сначала
                    self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    continue
                self.state, self.error = "offline", "нет кадров"
                try:
                    self.cap.release()
                except Exception:  # noqa: BLE001
                    pass
                self.cap = None
                time.sleep(1.0)
                continue
            with self.lock:
                self.frame, self.frame_ts = frame, time.time()
                self.shape = frame.shape[:2]
            self.state, self.error = "online", ""
            if self.is_file:  # не гоним файл быстрее его частоты кадров
                f = self.cap.get(cv2.CAP_PROP_FPS) or 25.0
                time.sleep(max(0.0, 1.0 / f - (time.time() - t0)))

    def latest(self):
        with self.lock:
            return self.frame, self.frame_ts

    # --- анализ
    def analyze(self, frame, detector, det_lock, now: float | None = None):
        """Один шаг: кадр → боксы людей → зоны. Возвращает dict с результатом (кадр не сохраняется)."""
        now = time.time() if now is None else now
        h, w = frame.shape[:2]
        img = frame
        if self.masks:  # закрашиваем исключённые области ДО модели: ИИ их не видит
            img = frame.copy()
            for m in self.masks:
                pts = np.round(m * np.array([w, h])).astype(np.int32)
                cv2.fillPoly(img, [pts], (0, 0, 0))
        with det_lock:
            boxes = detector.detect(img)
        feet, points = [], []
        raw = {k: 0 for k in self.hist}
        for (x1, y1, x2, y2, sc) in boxes:
            fx, fy = (x1 + x2) / 2.0 / w, min(1.0, y2 / h)  # точка «ног» на полу
            zkey = zid = None
            for i, z in enumerate(self.zones):
                if point_in_polygon(fx, fy, z["polygon"]):
                    zkey, zid = z["id"] + "#%d" % i, z["id"]
                    break
            feet.append((fx, fy, zkey))
            if zkey:  # всё, что вне объявленных зон, отбрасываем сразу
                raw[zkey] += 1
                points.append((fx, fy, zid))
        self.tracker.update(points, now)
        for k, v in raw.items():
            self.hist[k].append(v)
        self.persons_total = sum(raw.values())
        res = {"ts": now, "boxes": boxes, "feet": feet, "raw": raw}
        self.last = dict(res, fps=self.last.get("fps", 0.0))
        return res

    def _analyzer(self):
        period = 1.0 / max(0.2, self.fps)
        while not self.stop.is_set():
            t0 = time.time()
            frame, ts = self.latest()
            if frame is None or t0 - ts > 10.0:
                if frame is not None:
                    self.state, self.error = "offline", "камера не передаёт кадры"
                time.sleep(0.3)
                continue
            try:
                self.analyze(frame, HUB.detector, HUB.det_lock)
            except Exception as e:  # noqa: BLE001
                self.error = "ошибка анализа: %s" % e
                time.sleep(1.0)
            dt = time.time() - t0
            self.last["fps"] = 1.0 / dt if dt > 0 else 0.0
            time.sleep(max(0.0, period - dt))

    # --- сглаженные счётчики зоны
    def smooth_counts(self):
        out = {}
        for i, z in enumerate(self.zones):
            dq = self.hist[z["id"] + "#%d" % i]
            out[i] = int(round(float(np.median(list(dq))))) if dq else 0
        return out

    def online(self) -> bool:
        return self.state == "online" and (time.time() - self.frame_ts) < 10.0

    def ready(self) -> bool:
        """Есть хотя бы одно измерение по каждой зоне: «ещё не посчитали» не выдаём за «0 человек»."""
        return all(len(dq) > 0 for dq in self.hist.values())


# ================================================================ хаб: сводит камеры в ответ API
class Hub:
    def __init__(self, cfg: dict, cameras, detector):
        self.cfg, self.cameras, self.detector = cfg, cameras, detector
        self.det_lock = threading.Lock()
        self.t0 = time.time()

    def snapshot(self) -> dict:
        now = time.time()
        acc: dict[str, dict] = {}
        offline_zones = set()
        for cam in self.cameras:
            sc = cam.smooth_counts() if (cam.online() and cam.ready()) else None
            for i, z in enumerate(cam.zones):
                zid = z["id"]
                if sc is None:
                    offline_zones.add(zid)
                    continue
                a = acc.setdefault(zid, {"count": 0, "capacity": 0})
                a["count"] += sc[i]
                a["capacity"] += int(z.get("capacity", 1))
        zones = []
        for zid in ZONE_IDS:
            if zid in acc and zid not in offline_zones:  # зона с отключённой камерой — «нет данных», не выдумываем
                a = acc[zid]
                cap = max(1, a["capacity"])
                zones.append({"id": zid, "count": a["count"], "capacity": cap, "p": round(min(1.0, a["count"] / cap), 3),
                              "dwellMin": round(self._dwell(zid, now), 1)})
        people = sum(z["count"] for z in zones)
        return {
            "clubId": self.cfg.get("clubId", "proto"), "clubName": self.cfg.get("clubName", ""),
            "clubCap": sum(z["capacity"] for z in zones), "people": people, "zones": zones,
            "entrance": {"in10": 0, "out10": 0}, "flows": [],
            "cameras": {"total": len(self.cameras), "online": sum(1 for c in self.cameras if c.online() and c.ready())},
            "source": "ddx-edge", "ts": int(now * 1000),
            "status": "ok" if zones else "no-data",
        }

    def _dwell(self, zid: str, now: float) -> float:
        vals = [c.tracker.dwell_min(zid, now) for c in self.cameras if any(z["id"] == zid for z in c.zones)]
        vals = [v for v in vals if v > 0]
        return sum(vals) / len(vals) if vals else 0.0

    def health(self) -> dict:
        now = time.time()
        return {
            "ok": True, "detector": self.detector.name, "uptimeSec": int(now - self.t0),
            "cameras": [{"name": c.name, "state": "online" if c.online() else ("offline" if c.state == "online" else c.state),
                         "error": c.error, "lastFrameAgeSec": round(now - c.frame_ts, 1) if c.frame_ts else None,
                         "persons": c.persons_total, "analysisFps": round(c.last.get("fps", 0.0), 2)} for c in self.cameras],
        }


HUB: Hub  # задаётся в main()

# ================================================================ HTTP
STATIC_TOP = {"index.html", "sw.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"}
STATIC_EXT = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
              ".png": "image/png", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml"}


def static_file(app_dir: str, url_path: str):
    """Отдаём только файлы самого приложения. Всё остальное (edge/, docs/, config.json с паролями камер) — закрыто."""
    p = urllib.parse.unquote(url_path.split("?")[0].split("#")[0])
    if "\x00" in p or "\\" in p:
        return None
    p = posixpath.normpath("/" + p).lstrip("/")
    if p == "":
        p = "index.html"
    ok = p in STATIC_TOP or (p.startswith("ai/") and p.count("/") == 1 and os.path.splitext(p)[1] in (".js", ".css"))
    if not ok:
        return None
    full = os.path.join(app_dir, *p.split("/"))
    return full if os.path.isfile(full) else None


def make_handler(cfg: dict, app_dir: str | None):
    token = str(cfg.get("token") or "")

    class Handler(BaseHTTPRequestHandler):
        server_version = "DDXEdge/0.1"

        def log_message(self, fmt, *a):  # тишина: адреса камер и запросы в лог не пишем
            pass

        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Max-Age", "600")

        def _json(self, code: int, obj):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self._cors()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _authorized(self) -> bool:
            if not token:
                return True
            got = self.headers.get("Authorization", "")
            return hmac.compare_digest(got.encode(), ("Bearer " + token).encode())

        def do_GET(self):
            path = self.path.split("?")[0]
            if path.startswith("/v1/"):
                if not self._authorized():
                    return self._json(401, {"error": "unauthorized"})
                if path == "/v1/occupancy":
                    return self._json(200, HUB.snapshot())
                if path == "/v1/equipment":  # оборудование прототип не определяет: пустой список = «нет данных»
                    return self._json(200, {"items": []})
                if path == "/v1/health":
                    return self._json(200, HUB.health())
                return self._json(404, {"error": "not found"})
            if app_dir:
                f = static_file(app_dir, self.path)
                if f:
                    with open(f, "rb") as fh:
                        data = fh.read()
                    self.send_response(200)
                    self.send_header("Content-Type", STATIC_EXT.get(os.path.splitext(f)[1], "application/octet-stream"))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()

    return Handler


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # пакеты не отправляются, нужен только выбор сетевого интерфейса
        return s.getsockname()[0]
    except Exception:  # noqa: BLE001
        return "127.0.0.1"
    finally:
        s.close()


# ================================================================ конфиг
def validate_config(cfg: dict) -> dict:
    cams = cfg.get("cameras")
    if not isinstance(cams, list) or not cams:
        raise ValueError("в config.json нужен список cameras")
    seen = collections.Counter()
    for c in cams:
        if not c.get("zones"):
            raise ValueError("у камеры %s нет зон (zones)" % c.get("name", "?"))
        for z in c["zones"]:
            zid = z.get("id")
            if zid in FORBIDDEN_ZONES:
                raise ValueError("зона «%s» запрещена: %s" % (zid, FORBIDDEN_ZONES[zid]))
            if zid not in ZONE_IDS:
                raise ValueError("неизвестная зона «%s». Допустимо: %s" % (zid, ", ".join(ZONE_IDS)))
            poly = z.get("polygon", [])
            if len(poly) < 3 or any(len(pt) != 2 or not (0 <= pt[0] <= 1 and 0 <= pt[1] <= 1) for pt in poly):
                raise ValueError("зона «%s»: polygon — минимум 3 точки [x, y] в долях кадра от 0 до 1" % zid)
            seen[zid] += 1
    for zid, n in seen.items():
        if n > 1:
            log("⚠ зона «%s» описана %d раза: вместимости сложатся, а области не должны перекрываться (иначе будет двойной счёт)" % (zid, n))
    return cfg


def load_config(args) -> dict:
    path = args.config or os.path.join(HERE, "config.json")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
        merged = dict(DEFAULT_CONFIG)
        merged.update(cfg)
        log("настройки: %s" % path)
    else:
        merged = json.loads(json.dumps(DEFAULT_CONFIG))
        log("файла config.json нет — берём настройки по умолчанию (камера MacBook, две зоны: левая и правая половина кадра)")
    if args.source:
        merged["cameras"][0]["source"] = args.source
    if args.port:
        merged["port"] = args.port
    if args.fps:
        merged["fps"] = args.fps
    if args.model:
        merged["model"] = args.model
    return validate_config(merged)


# ================================================================ служебные команды
def download_model(name: str) -> int:
    m = MODELS.get(name)
    if not m:
        print("Модели: " + ", ".join(MODELS))
        return 2
    os.makedirs(os.path.join(HERE, "models"), exist_ok=True)
    dest = os.path.join(HERE, "models", m["file"])
    if os.path.isfile(dest) and hashlib.sha256(open(dest, "rb").read()).hexdigest() == m["sha256"]:
        print("Модель уже скачана: %s" % dest)
        return 0
    print("Скачиваю %s (это один раз) …" % m["file"])
    tmp = dest + ".part"
    with urllib.request.urlopen(m["url"], timeout=60) as r, open(tmp, "wb") as out:
        total = int(r.headers.get("Content-Length") or 0)
        got = 0
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            out.write(chunk)
            got += len(chunk)
            if total:
                print("\r  %d%%" % (got * 100 // total), end="", flush=True)
    print()
    digest = hashlib.sha256(open(tmp, "rb").read()).hexdigest()
    if digest != m["sha256"]:
        os.remove(tmp)
        print("Файл повреждён или изменён (контрольная сумма не совпала). Попробуйте ещё раз.")
        return 1
    os.replace(tmp, dest)
    print("Готово: %s" % dest)
    return 0


PROBE_PATHS = ["/h264_hd.sdp", "/h264_vga.sdp", "/stream1", "/stream2", "/live/ch0", "/"]


def probe(ip: str, user: str, password: str | None) -> int:
    if password is None:
        password = getpass.getpass("Пароль камеры (не отображается при вводе): ")
    print("Пробую типичные адреса камеры %s …" % ip)
    for path in PROBE_PATHS:
        src = build_source({"url": "rtsp://%s:554%s" % (ip, path), "user": user, "password": password})
        cap = cv2.VideoCapture(src, cv2.CAP_FFMPEG)
        ok, frame = (cap.read() if cap.isOpened() else (False, None))
        cap.release()
        if ok and frame is not None:
            print("  ✓ %-16s работает, кадр %dx%d" % (path, frame.shape[1], frame.shape[0]))
            print("\nВ config.json пропишите источник так:")
            print('  "source": {"url": "rtsp://%s:554%s", "user": "%s", "password": "ВАШ_ПАРОЛЬ"}' % (ip, path, user))
            return 0
        print("  ✗ %-16s не открылся" % path)
    print("\nНи один адрес не открылся. Проверьте: камера в той же Wi-Fi сети, верный логин/пароль камеры,")
    print("в приложении камеры включён доступ для сторонних программ (RTSP/ONVIF, «аккаунт камеры»).")
    print("Пока можно проверять прототип на камере MacBook:  python3 ddx_edge.py --source 0 --preview")
    return 1


def run_image(path: str, cfg: dict, detector) -> int:
    img = cv2.imread(path)
    if img is None:
        print("Не удалось прочитать картинку %s" % path)
        return 1
    cam = Camera(cfg["cameras"][0], 1.0, 1)
    res = cam.analyze(img, detector, threading.Lock())
    print("Найдено людей на картинке: %d (в зонах: %d)" % (len(res["boxes"]), sum(res["raw"].values())))
    for k, v in res["raw"].items():
        print("  зона %-10s %d" % (k.split("#")[0], v))
    return 0


# ================================================================ окно предпросмотра (только для настройки)
def run_preview(cameras):
    names = {}
    clicks = {}

    def on_mouse(event, x, y, _flags, cam):
        if event == cv2.EVENT_LBUTTONDOWN and cam.shape:
            h, w = cam.shape
            print("  точка для polygon: [%.3f, %.3f]   (%s)" % (x / w, y / h, cam.name), flush=True)

    for cam in cameras:
        win = "DDX Edge - %s (q = quit, click = coords)" % cam.name
        names[cam.name] = win
        cv2.namedWindow(win, cv2.WINDOW_NORMAL)
        cv2.setMouseCallback(win, on_mouse, cam)
    palette = [(255, 160, 0), (0, 200, 255), (80, 220, 100), (200, 80, 255), (60, 60, 255), (255, 200, 120)]
    while True:
        for cam in cameras:
            frame, _ts = cam.latest()
            win = names[cam.name]
            if frame is None:
                blank = np.zeros((360, 640, 3), np.uint8)
                cv2.putText(blank, "%s: %s" % (cam.name, cam.error or "ждём кадр…"), (20, 180), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
                cv2.imshow(win, blank)
                continue
            vis = frame.copy()
            h, w = vis.shape[:2]
            for m in cam.masks:
                pts = np.round(m * np.array([w, h])).astype(np.int32)
                ov = vis.copy()
                cv2.fillPoly(ov, [pts], (0, 0, 0))
                vis = cv2.addWeighted(ov, 0.7, vis, 0.3, 0)
            counts = cam.smooth_counts()
            for i, z in enumerate(cam.zones):
                col = palette[i % len(palette)]
                pts = np.round(np.array(z["polygon"]) * np.array([w, h])).astype(np.int32)
                cv2.polylines(vis, [pts], True, col, 2)
                label = "%s %d/%d" % (z["id"], counts.get(i, 0), int(z.get("capacity", 1)))
                cv2.putText(vis, label, (int(pts[:, 0].min()) + 6, int(pts[:, 1].min()) + 22), cv2.FONT_HERSHEY_SIMPLEX, 0.65, col, 2)
            for (x1, y1, x2, y2, sc) in cam.last.get("boxes", []):
                cv2.rectangle(vis, (int(x1), int(y1)), (int(x2), int(y2)), (0, 255, 0), 2)
                cv2.putText(vis, "person %.2f" % sc, (int(x1), max(14, int(y1) - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
            for (fx, fy, zk) in cam.last.get("feet", []):
                cv2.circle(vis, (int(fx * w), int(fy * h)), 5, (0, 0, 255) if zk else (128, 128, 128), -1)
            cv2.imshow(win, vis)
        k = cv2.waitKey(40) & 0xFF
        if k in (ord("q"), 27):
            break
    cv2.destroyAllWindows()


# ================================================================ main
def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="DDX Vision Edge — прототип: люди в кадре → числа по зонам → API для приложения")
    ap.add_argument("--config", help="путь к config.json (по умолчанию рядом со скриптом)")
    ap.add_argument("--source", help="источник первой камеры: 0 (камера Mac), путь к видео или rtsp://… адрес")
    ap.add_argument("--port", type=int, help="порт сервера (по умолчанию 8787)")
    ap.add_argument("--fps", type=float, help="сколько раз в секунду анализировать кадр (по умолчанию 2)")
    ap.add_argument("--model", help="tiny (быстрее) или s (точнее) либо путь к .onnx")
    ap.add_argument("--detector", choices=["yolox", "hog"], help="hog — запасной вариант без скачивания модели")
    ap.add_argument("--preview", action="store_true", help="окно с рамками и зонами (для настройки, ничего не сохраняет)")
    ap.add_argument("--local-only", action="store_true", help="слушать только этот компьютер (127.0.0.1)")
    ap.add_argument("--app-dir", help="папка приложения DDX Vision (по умолчанию — на уровень выше)")
    ap.add_argument("--no-app", action="store_true", help="не раздавать приложение, только API")
    ap.add_argument("--download-model", nargs="?", const="tiny", metavar="tiny|s", help="скачать модель людей и выйти")
    ap.add_argument("--probe-ip", metavar="IP", help="подобрать адрес потока камеры по её IP и выйти")
    ap.add_argument("--user", default="admin", help="логин камеры для --probe-ip")
    ap.add_argument("--image", metavar="ФАЙЛ", help="проверить на одной картинке и выйти")
    return ap.parse_args(argv)


def main(argv=None) -> int:
    global HUB
    args = parse_args(argv)
    if args.download_model:
        return download_model(args.download_model)
    if args.probe_ip:
        return probe(args.probe_ip, args.user, None)
    cfg = load_config(args)
    try:
        detector = build_detector(cfg, args)
    except Exception as e:  # noqa: BLE001
        print("Ошибка модели: %s" % e)
        return 1
    if args.image:
        return run_image(args.image, cfg, detector)
    cameras = [Camera(c, float(cfg.get("fps", 2.0)), int(cfg.get("smoothing", 5))) for c in cfg["cameras"]]
    for cam in cameras:  # первое открытие — в главном потоке (macOS спросит доступ к камере)
        ok = cam.open()
        log("камера %s: %s" % (cam.name, "открыта" if ok else "пока недоступна (%s) — буду пробовать снова" % cam.error))
    HUB = Hub(cfg, cameras, detector)
    for cam in cameras:
        cam.start()
    app_dir = None if args.no_app else os.path.abspath(args.app_dir or os.path.join(HERE, ".."))
    if app_dir and not os.path.isfile(os.path.join(app_dir, "index.html")):
        log("⚠ в %s нет index.html — приложение раздаваться не будет (только API)" % app_dir)
        app_dir = None
    host = "127.0.0.1" if args.local_only else "0.0.0.0"
    port = int(cfg.get("port", 8787))
    try:
        server = ThreadingHTTPServer((host, port), make_handler(cfg, app_dir))
    except OSError as e:
        print("Не удалось занять порт %d (%s). Закройте прошлый запуск или укажите другой: --port 8788" % (port, e))
        return 1
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, name="http", daemon=True).start()
    print()
    log("DDX Vision Edge запущен. Детектор: %s. Кадры не сохраняются, наружу идут только числа." % detector.name)
    if app_dir:
        log("Откройте в Safari на этом компьютере:  http://localhost:%d/#live" % port)
        if not args.local_only:
            log("С другого компьютера или телефона (та же Wi-Fi):  http://%s:%d/#live" % (lan_ip(), port))
    log("Проверка API:  http://localhost:%d/v1/occupancy    (остановить: Ctrl+C)" % port)
    print()
    def _stop(*_):  # Ctrl+C и обычное завершение процесса — одинаково корректные
        raise KeyboardInterrupt

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    try:
        if args.preview:
            run_preview(cameras)
        else:
            while True:
                time.sleep(3.0)
                snap = HUB.snapshot()
                parts = ["%s %d/%d" % (z["id"], z["count"], z["capacity"]) for z in snap["zones"]]
                states = ", ".join("%s: %s" % (c.name, "ок" if c.online() else c.state) for c in cameras)
                log("людей в зонах: %d | %s | %s" % (snap["people"], ", ".join(parts) or "—", states))
    except KeyboardInterrupt:
        pass
    finally:
        for cam in cameras:
            cam.stop.set()
        server.shutdown()
    print("Остановлено.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
