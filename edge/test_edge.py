#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Проверки прототипа DDX Vision Edge.
Запуск:  python3 -m unittest -v test_edge      (из папки edge)
Тесты с настоящей моделью включаются, если модель скачана (или задана DDX_TEST_MODEL=путь.onnx)."""
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import cv2
import numpy as np

import ddx_edge as E

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
MODEL = os.environ.get("DDX_TEST_MODEL") or os.path.join(HERE, "models", "yolox_tiny.onnx")
SAMPLE = os.environ.get("DDX_TEST_IMAGE", "")


class FakeDetector:
    name = "fake"

    def __init__(self, boxes):
        self.boxes, self.seen = boxes, []

    def detect(self, img):
        self.seen.append(img.copy())
        return self.boxes


def cam_cfg(zones, masks=None, name="c1"):
    return {"name": name, "source": "0", "zones": zones, "masks": masks or []}


LEFT = [[0, 0], [0.5, 0], [0.5, 1], [0, 1]]
RIGHT = [[0.5, 0], [1, 0], [1, 1], [0.5, 1]]


class Geometry(unittest.TestCase):
    def test_point_in_polygon(self):
        sq = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]
        self.assertTrue(E.point_in_polygon(0.5, 0.5, sq))
        self.assertFalse(E.point_in_polygon(0.1, 0.5, sq))
        self.assertFalse(E.point_in_polygon(0.5, 0.9, sq))
        tri = [[0, 0], [1, 0], [0, 1]]
        self.assertTrue(E.point_in_polygon(0.2, 0.2, tri))
        self.assertFalse(E.point_in_polygon(0.8, 0.8, tri))

    def test_mask_url_hides_password(self):
        self.assertEqual(E.mask_url("rtsp://admin:secret@192.168.0.5:554/h264_hd.sdp"), "rtsp://***@192.168.0.5:554/h264_hd.sdp")
        self.assertEqual(E.mask_url("rtsp://192.168.0.5/x"), "rtsp://192.168.0.5/x")

    def test_build_source_encodes_special_characters(self):
        u = E.build_source({"url": "rtsp://10.0.0.7:554/h264_hd.sdp", "user": "admin", "password": "p@ss:w/rd"})
        self.assertEqual(u, "rtsp://admin:p%40ss%3Aw%2Frd@10.0.0.7:554/h264_hd.sdp")
        self.assertEqual(E.build_source("0"), 0)
        self.assertEqual(E.build_source("clip.mp4"), "clip.mp4")


class ConfigRules(unittest.TestCase):
    def base(self, zones):
        return {"cameras": [cam_cfg(zones)]}

    def test_default_config_is_valid(self):
        E.validate_config(json.loads(json.dumps(E.DEFAULT_CONFIG)))

    def test_example_config_is_valid_and_sources_build(self):
        with open(os.path.join(HERE, "config.example.json"), encoding="utf-8") as f:
            cfg = E.validate_config(json.load(f))
        self.assertEqual(len(cfg["cameras"]), 2)
        for c in cfg["cameras"]:
            self.assertTrue(E.build_source(c["source"]).startswith("rtsp://admin:"))

    def test_runs_on_python_39_syntax(self):
        import ast
        src = open(os.path.join(HERE, "ddx_edge.py"), encoding="utf-8").read()
        ast.parse(src, feature_version=(3, 9))  # на Mac может стоять Python 3.9

    def test_locker_zone_is_forbidden(self):
        with self.assertRaises(ValueError) as cm:
            E.validate_config(self.base([{"id": "locker", "capacity": 5, "polygon": LEFT}]))
        self.assertIn("раздевалк", str(cm.exception))

    def test_unknown_zone_and_bad_polygon(self):
        with self.assertRaises(ValueError):
            E.validate_config(self.base([{"id": "sauna", "capacity": 5, "polygon": LEFT}]))
        with self.assertRaises(ValueError):
            E.validate_config(self.base([{"id": "chest", "capacity": 5, "polygon": [[0, 0], [1, 1]]}]))
        with self.assertRaises(ValueError):
            E.validate_config(self.base([{"id": "chest", "capacity": 5, "polygon": [[0, 0], [2, 0], [1, 1]]}]))
        with self.assertRaises(ValueError):
            E.validate_config({"cameras": []})


class TrackerDwell(unittest.TestCase):
    def test_dwell_of_completed_visits(self):
        tr = E.Tracker()
        t = 1000.0
        for visit in range(3):  # три человека по очереди проводят в зоне по 2 минуты
            for k in range(240):
                tr.update([(0.2 + visit * 0.01, 0.5, "chest")], t)
                t += 0.5
            for k in range(10):  # ушли из кадра
                tr.update([], t)
                t += 0.5
        self.assertGreaterEqual(len(tr.visits["chest"]), 3)
        self.assertAlmostEqual(tr.dwell_min("chest", t), 2.0, delta=0.2)

    def test_current_residence_when_no_history(self):
        tr = E.Tracker()
        t = 0.0
        for _ in range(120):
            tr.update([(0.5, 0.5, "free")], t)
            t += 0.5
        self.assertAlmostEqual(tr.dwell_min("free", t), 1.0, delta=0.1)

    def test_two_people_do_not_merge_and_ids_expire(self):
        tr = E.Tracker()
        tr.update([(0.2, 0.5, "chest"), (0.8, 0.5, "cardio")], 0.0)
        self.assertEqual(len(tr.tracks), 2)
        tr.update([(0.21, 0.5, "chest"), (0.79, 0.5, "cardio")], 0.5)
        self.assertEqual(len(tr.tracks), 2)
        tr.update([], 10.0)  # дольше TTL — забыты
        self.assertEqual(len(tr.tracks), 0)


class YoloxDecode(unittest.TestCase):
    def make(self):
        d = object.__new__(E.YoloxDetector)
        d.conf, d.nms, d.size = 0.4, 0.45, 416
        d.grid, d.stride = d._grids(416)
        return d

    def test_decode_recovers_box_and_applies_letterbox(self):
        d = self.make()
        n = d.grid.shape[0]
        raw = np.zeros((n, 85), np.float32)
        raw[:, 4] = 0.01
        a = 200  # якорь первого уровня (stride 8)
        gx, gy = d.grid[a]
        # хотим бокс с центром (100, 150) и размером 40×80 во входе модели
        raw[a, 0] = (100 - gx * 8) / 8
        raw[a, 1] = (150 - gy * 8) / 8
        raw[a, 2] = np.log(40 / 8)
        raw[a, 3] = np.log(80 / 8)
        raw[a, 4], raw[a, 5] = 0.9, 0.9
        r = 0.5  # исходный кадр вдвое больше входа
        res = d.decode(raw, r, 1000, 1000)
        self.assertEqual(len(res), 1)
        x1, y1, x2, y2, sc = res[0]
        self.assertAlmostEqual(x1, 160, delta=1)
        self.assertAlmostEqual(y1, 220, delta=1)
        self.assertAlmostEqual(x2, 240, delta=1)
        self.assertAlmostEqual(y2, 380, delta=1)
        self.assertAlmostEqual(sc, 0.81, places=2)

    def test_other_classes_and_weak_scores_are_ignored(self):
        d = self.make()
        raw = np.zeros((d.grid.shape[0], 85), np.float32)
        raw[:, 4] = 0.9
        raw[:, 6] = 0.99  # другой класс (не person), person-вероятность ≈ 0
        self.assertEqual(d.decode(raw, 1.0, 640, 480), [])


class CameraAnalysis(unittest.TestCase):
    def frame(self, w=640, h=480):
        return np.full((h, w, 3), 200, np.uint8)

    def test_people_are_counted_by_foot_point_and_outside_is_dropped(self):
        cam = E.Camera(cam_cfg([{"id": "chest", "capacity": 3, "polygon": LEFT}, {"id": "cardio", "capacity": 3, "polygon": RIGHT}]), 2.0, 1)
        # ноги: левая половина ×2, правая ×1; ещё один бокс с ногами ниже кадра (клиппинг) — всё равно в зоне
        det = FakeDetector([(50, 100, 150, 400, .9), (200, 120, 280, 300, .8), (400, 100, 500, 420, .7)])
        res = cam.analyze(self.frame(), det, threading.Lock(), now=10.0)
        self.assertEqual(res["raw"]["chest#0"], 2)
        self.assertEqual(res["raw"]["cardio#1"], 1)
        self.assertEqual(cam.persons_total, 3)

    def test_person_outside_every_zone_is_not_counted(self):
        small = [[0, 0], [0.3, 0], [0.3, 0.3], [0, 0.3]]
        cam = E.Camera(cam_cfg([{"id": "chest", "capacity": 3, "polygon": small}]), 2.0, 1)
        det = FakeDetector([(400, 300, 500, 450, .9)])
        cam.analyze(self.frame(), det, threading.Lock(), now=1.0)
        self.assertEqual(cam.persons_total, 0)

    def test_masks_are_blacked_out_before_the_model_sees_them(self):
        mask = [[0.5, 0.5], [1, 0.5], [1, 1], [0.5, 1]]
        cam = E.Camera(cam_cfg([{"id": "chest", "capacity": 3, "polygon": LEFT}], masks=[mask]), 2.0, 1)
        det = FakeDetector([])
        cam.analyze(self.frame(), det, threading.Lock(), now=1.0)
        seen = det.seen[0]
        self.assertEqual(int(seen[400, 500].sum()), 0)      # внутри маски — чёрный
        self.assertEqual(int(seen[100, 100][0]), 200)       # вне маски — как был
        self.assertEqual(int(self.frame()[400, 500][0]), 200)  # исходный кадр не тронут

    def test_smoothing_uses_median(self):
        cam = E.Camera(cam_cfg([{"id": "chest", "capacity": 5, "polygon": LEFT}]), 2.0, 5)
        for n in (2, 2, 9, 2, 2):  # одиночный выброс не должен менять показание
            det = FakeDetector([(10 + i * 20, 10, 25 + i * 20, 200, .9) for i in range(n)])
            cam.analyze(self.frame(), det, threading.Lock(), now=1.0)
        self.assertEqual(cam.smooth_counts()[0], 2)


def online_cam(zones, counts, name="c1"):
    cam = E.Camera(cam_cfg(zones, name=name), 2.0, 1)
    cam.state, cam.frame_ts = "online", time.time()
    for i, c in enumerate(counts):
        cam.hist[zones[i]["id"] + "#%d" % i].append(c)
    return cam


class HubContract(unittest.TestCase):
    def test_occupancy_matches_app_contract(self):
        cam = online_cam([{"id": "chest", "capacity": 4, "polygon": LEFT}, {"id": "cardio", "capacity": 3, "polygon": RIGHT}], [2, 3])
        hub = E.Hub({"clubId": "x", "clubName": "Тест"}, [cam], FakeDetector([]))
        s = hub.snapshot()
        self.assertEqual(s["status"], "ok")
        self.assertEqual(s["people"], 5)
        self.assertEqual(s["clubCap"], 7)
        z = {x["id"]: x for x in s["zones"]}
        self.assertEqual(z["chest"]["count"], 2)
        self.assertEqual(z["chest"]["capacity"], 4)
        self.assertAlmostEqual(z["chest"]["p"], 0.5)
        self.assertEqual(z["cardio"]["p"], 1.0)
        for k in ("id", "count", "capacity", "p", "dwellMin"):
            self.assertIn(k, z["chest"])
        self.assertEqual(s["entrance"], {"in10": 0, "out10": 0})

    def test_offline_camera_gives_no_data_not_zero(self):
        a = online_cam([{"id": "chest", "capacity": 4, "polygon": LEFT}], [2], "a")
        b = online_cam([{"id": "cardio", "capacity": 4, "polygon": RIGHT}], [1], "b")
        b.state = "offline"
        s = E.Hub({}, [a, b], FakeDetector([])).snapshot()
        self.assertEqual([x["id"] for x in s["zones"]], ["chest"])  # у cardio камера молчит → зоны нет вовсе
        a.state = "offline"
        s = E.Hub({}, [a, b], FakeDetector([])).snapshot()
        self.assertEqual(s["zones"], [])
        self.assertEqual(s["status"], "no-data")

    def test_nothing_is_reported_before_the_first_measurement(self):
        cam = E.Camera(cam_cfg([{"id": "chest", "capacity": 4, "polygon": LEFT}]), 2.0, 1)
        cam.state, cam.frame_ts = "online", time.time()  # кадр есть, анализа ещё не было
        s = E.Hub({}, [cam], FakeDetector([])).snapshot()
        self.assertEqual(s["zones"], [])  # не «0 человек», а «данных пока нет»
        self.assertEqual(s["status"], "no-data")
        self.assertEqual(s["cameras"], {"total": 1, "online": 0})
        cam.hist["chest#0"].append(2)
        s = E.Hub({}, [cam], FakeDetector([])).snapshot()
        self.assertEqual(s["zones"][0]["count"], 2)
        self.assertEqual(s["cameras"], {"total": 1, "online": 1})

    def test_two_cameras_on_one_zone_are_summed_but_not_if_one_is_down(self):
        a = online_cam([{"id": "free", "capacity": 5, "polygon": LEFT}], [2], "a")
        b = online_cam([{"id": "free", "capacity": 5, "polygon": RIGHT}], [3], "b")
        hub = E.Hub({}, [a, b], FakeDetector([]))
        z = hub.snapshot()["zones"][0]
        self.assertEqual((z["count"], z["capacity"]), (5, 10))
        b.state = "offline"
        self.assertEqual(hub.snapshot()["zones"], [])  # половина зоны не видна — не показываем заниженное число


class HttpApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cam = online_cam([{"id": "chest", "capacity": 4, "polygon": LEFT}], [2])
        E.HUB = E.Hub({"clubId": "t", "clubName": "T"}, [cam], FakeDetector([]))
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), E.make_handler({"token": ""}, ROOT))
        cls.srv_tok = ThreadingHTTPServer(("127.0.0.1", 0), E.make_handler({"token": "s3cret"}, ROOT))
        for s in (cls.srv, cls.srv_tok):
            threading.Thread(target=s.serve_forever, daemon=True).start()
        cls.base = "http://127.0.0.1:%d" % cls.srv.server_address[1]
        cls.base_tok = "http://127.0.0.1:%d" % cls.srv_tok.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv_tok.shutdown()

    def get(self, url, headers=None):
        req = urllib.request.Request(url, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def test_occupancy_and_cors(self):
        st, h, body = self.get(self.base + "/v1/occupancy")
        self.assertEqual(st, 200)
        self.assertEqual(h["Access-Control-Allow-Origin"], "*")
        self.assertIn("application/json", h["Content-Type"])
        j = json.loads(body)
        self.assertEqual(j["zones"][0]["id"], "chest")
        self.assertEqual(self.get(self.base + "/v1/equipment")[0], 200)
        self.assertEqual(json.loads(self.get(self.base + "/v1/equipment")[2]), {"items": []})
        self.assertEqual(self.get(self.base + "/v1/health")[0], 200)
        self.assertEqual(self.get(self.base + "/v1/nothing")[0], 404)

    def test_preflight(self):
        req = urllib.request.Request(self.base + "/v1/occupancy", method="OPTIONS")
        with urllib.request.urlopen(req, timeout=5) as r:
            self.assertEqual(r.status, 204)
            self.assertIn("authorization", r.headers["Access-Control-Allow-Headers"].lower())

    def test_token(self):
        self.assertEqual(self.get(self.base_tok + "/v1/occupancy")[0], 401)
        self.assertEqual(self.get(self.base_tok + "/v1/occupancy", {"Authorization": "Bearer wrong"})[0], 401)
        self.assertEqual(self.get(self.base_tok + "/v1/occupancy", {"Authorization": "Bearer s3cret"})[0], 200)

    def test_app_is_served(self):
        st, h, body = self.get(self.base + "/")
        self.assertEqual(st, 200)
        self.assertIn(b"DDX", body)
        self.assertEqual(self.get(self.base + "/ai/core.js")[0], 200)
        self.assertEqual(self.get(self.base + "/ai/ai.css")[0], 200)
        self.assertEqual(self.get(self.base + "/sw.js")[0], 200)

    def test_secrets_and_other_files_are_not_served(self):
        for p in ("/edge/config.json", "/edge/config.example.json", "/edge/ddx_edge.py", "/docs/AI-ENGINE.md", "/.git/config", "/.gitignore",
                  "/tests/e2e.mjs", "/../etc/passwd", "/%2e%2e/etc/passwd", "/ai/../edge/ddx_edge.py", "/ai/%2e%2e/edge/ddx_edge.py",
                  "/ai/", "/ai", "/edge/", "//etc/passwd", "/ai/core.js/../../edge/ddx_edge.py"):
            self.assertEqual(self.get(self.base + p)[0], 404, p)

    def test_static_helper_rejects_traversal(self):
        for p in ("/../x", "/ai/../index.html/../../x", "/a\\b", "/index.html%00.png"):
            self.assertIsNone(E.static_file(ROOT, p), p)


class PrivacyGuards(unittest.TestCase):
    def test_source_has_no_way_to_write_or_send_images(self):
        src = open(os.path.join(HERE, "ddx_edge.py"), encoding="utf-8").read()
        for word in ("imwrite", "VideoWriter", "imencode", "tofile"):
            self.assertNotIn(word, src, "в коде не должно быть сохранения кадров: " + word)
        self.assertNotIn("/snapshot", src)
        self.assertNotIn("multipart/x-mixed-replace", src)  # нет потока MJPEG наружу

    def test_api_exposes_only_numbers(self):
        cam = online_cam([{"id": "chest", "capacity": 4, "polygon": LEFT}], [2])
        s = json.dumps(E.Hub({"clubId": "t", "clubName": "T"}, [cam], FakeDetector([])).snapshot())
        for bad in ("rtsp", "password", "jpg", "base64", "frame"):
            self.assertNotIn(bad, s.lower())


@unittest.skipUnless(os.path.isfile(MODEL), "модель не скачана (python3 ddx_edge.py --download-model)")
class RealModel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.det = E.YoloxDetector(MODEL)

    def test_finds_people_in_synthetic_scene(self):
        img = None
        for cand in (SAMPLE,):
            if cand and os.path.isfile(cand):
                img = cv2.imread(cand)
        if img is None:
            self.skipTest("нет тестовой фотографии (DDX_TEST_IMAGE=путь.jpg)")
        res = self.det.detect(img)
        self.assertGreaterEqual(len(res), 3)

    def test_empty_scene_has_no_people(self):
        self.assertEqual(self.det.detect(np.full((480, 640, 3), 128, np.uint8)), [])

    def test_video_pipeline_counts_people_without_saving_frames(self):
        if not (SAMPLE and os.path.isfile(SAMPLE)):
            self.skipTest("нет тестовой фотографии")
        img = cv2.resize(cv2.imread(SAMPLE), (1280, 720))
        tmp = tempfile.mkdtemp()
        path = os.path.join(tmp, "clip.mp4")
        vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), 10, (1280, 720))
        for _ in range(40):
            vw.write(img)
        vw.release()
        cam = E.Camera(cam_cfg([{"id": "free", "capacity": 6, "polygon": [[0, 0], [1, 0], [1, 1], [0, 1]]}]), 4.0, 3)
        cam.source, cam.is_file = path, True
        E.HUB = E.Hub({}, [cam], self.det)
        self.assertTrue(cam.open())
        cam.start()
        deadline = time.time() + 20
        while time.time() < deadline and not (cam.persons_total >= 3 and cam.online() and len(cam.hist["free#0"]) >= 3):
            time.sleep(0.2)
        cam.stop.set()
        s = E.HUB.snapshot()
        self.assertEqual(s["status"], "ok")
        self.assertGreaterEqual(s["people"], 3)
        self.assertEqual(os.listdir(tmp), ["clip.mp4"])  # программа ничего не дописала на диск


if __name__ == "__main__":
    unittest.main(verbosity=2)
