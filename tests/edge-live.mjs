/* Сквозная проверка прототипа edge: настоящий сервер ddx_edge.py читает видео, находит людей,
   приложение в браузере по адресу #live само подключается и показывает числа.
   Видео делается из одной фотографии с людьми: 5 с «люди в кадре», 5 с «пустой зал», по кругу — так видно, что приложение следит за живыми изменениями.
   Запуск:  DDX_PY=путь/к/python DDX_MODEL=путь/к/yolox_tiny.onnx DDX_IMAGE=путь/к/фото_с_людьми.jpg node tests/edge-live.mjs */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let chromium; try { ({ chromium } = await import('playwright')); } catch (e) { ({ chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs')); }
const PY = process.env.DDX_PY || 'python3', MODEL = process.env.DDX_MODEL, IMAGE = process.env.DDX_IMAGE, PORT = 8799;
if (!MODEL || !IMAGE) { console.error('Нужны DDX_MODEL и DDX_IMAGE'); process.exit(2); }
const CLIP = path.join(os.tmpdir(), 'ddx-edge-test-clip.mp4');
const mk = spawnSync(PY, ['-c', `
import cv2, numpy as np, sys
img = cv2.resize(cv2.imread(sys.argv[1]), (1280, 720)); empty = np.full((720, 1280, 3), 120, np.uint8)
vw = cv2.VideoWriter(sys.argv[2], cv2.VideoWriter_fourcc(*'mp4v'), 10, (1280, 720))
for i in range(100): vw.write(img if i < 50 else empty)
vw.release()`, IMAGE, CLIP]);
if (mk.status !== 0) { console.error('не удалось сделать тестовое видео', String(mk.stderr)); process.exit(2); }

const edge = spawn(PY, [path.join(root, 'edge/ddx_edge.py'), '--source', CLIP, '--port', String(PORT), '--model', MODEL, '--fps', '4'], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; edge.stdout.on('data', d => out += d); edge.stderr.on('data', d => out += d);
const API = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0, failed = 0;
const step = async (name, fn) => { try { await fn(); n++; console.log('  ok  ' + name); } catch (e) { failed++; console.error('  FAIL ' + name + '\n     ' + String(e.message).split('\n').slice(0, 5).join('\n     ')); } };

let browser;
try {
  let j = null;
  for (let i = 0; i < 80 && !(j && j.zones && j.zones.length); i++) { await sleep(500); try { j = await (await fetch(API + '/v1/occupancy')).json(); } catch (e) { /* ждём запуск */ } }
  assert.ok(j && j.zones.length, 'сервер не отдал зоны за 40 с\n' + out);

  console.log('— сервер edge');
  await step('API отдаёт зоны с людьми', async () => { assert.equal(j.status, 'ok'); assert.ok(j.people >= 3, 'people=' + j.people); assert.ok(j.zones.every(z => z.capacity >= 1 && z.p >= 0 && z.p <= 1)); });
  await step('оборудование не выдумывается', async () => { assert.deepEqual(await (await fetch(API + '/v1/equipment')).json(), { items: [] }); });
  await step('секреты и код не раздаются', async () => { for (const p of ['/edge/config.json', '/edge/ddx_edge.py', '/.git/config', '/docs/AI-ENGINE.md']) assert.equal((await fetch(API + p)).status, 404, p); });

  console.log('— приложение в браузере');
  browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage(); const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.goto(API + '/#live', { waitUntil: 'load' });
  await page.waitForFunction(() => window.DDXAI && window.DDXAI.orch && window.DDXAI.orch.mode === 'LIVE', null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3500);

  await step('#live сам подключил приложение в режим LIVE', async () => { assert.equal(await page.evaluate(() => window.DDXAI.orch.mode), 'LIVE'); });
  await step('приложение следит за живыми изменениями: видны и «люди в кадре», и «пустой зал»', async () => {
    const seen = new Set();
    for (let i = 0; i < 70; i++) { seen.add(await page.evaluate(() => { const s = window.DDXAI.ui.snap(); return s.empty ? -1 : s.people; })); await page.waitForTimeout(300); if ([...seen].some(v => v >= 3) && seen.has(0)) break; }
    assert.ok([...seen].some(v => v >= 3) && seen.has(0), 'наблюдали: ' + [...seen].join(','));
  });
  await step('приложение показывает ровно то, что насчитал сервер', async () => {
    const snap = await page.evaluate(() => { const s = window.DDXAI.ui.snap(); return { empty: !!s.empty, zones: (s.zones || []).map(z => ({ id: z.id, count: z.count })) }; });
    const live = await (await fetch(API + '/v1/occupancy')).json();
    assert.equal(snap.empty, false, 'снимок пустой');
    assert.deepEqual(snap.zones.map(z => z.id).sort(), live.zones.map(z => z.id).sort());
    for (const z of live.zones) assert.ok(Math.abs(snap.zones.find(x => x.id === z.id).count - z.count) <= 3, 'зона ' + z.id);
  });
  await step('приложение само открыло экран AI LIVE и показало зоны', async () => {
    assert.equal(await page.evaluate(() => window.DDX.state.screen), 'live');
    const txt = await page.evaluate(() => document.querySelector('[data-screen="live"]').innerText);
    assert.match(txt, /LIVE/); assert.ok(/Грудь|Кардио|CHEST|CARDIO/i.test(txt), txt.slice(0, 400));
  });
  await step('шапка в LIVE не врёт про «12 камер» демо-клуба', async () => {
    const h = await page.evaluate(() => ({ cams: document.querySelector('[data-camsline]').textContent, club: document.querySelector('[data-clubname]').textContent }));
    assert.match(h.cams, /^1 из 1 камер/); assert.ok(!/Ватутинки/.test(h.club), h.club);
  });
  await step('зоны без данных не подменяются демо (в потоке только 2 зоны)', async () => {
    const ids = await page.evaluate(() => window.DDXAI.ui.snap().zones.map(z => z.id));
    assert.ok(ids.length <= 2 && !ids.includes('free'), ids.join(','));
  });
  await page.screenshot({ path: process.env.DDX_SHOT || '/tmp/edge-live.png' });
  await step('в консоли браузера нет ошибок', async () => { const bad = errs.filter(e => !/favicon/i.test(e)); assert.equal(bad.length, 0, bad.join('\n')); });

  console.log('— сервер остановлен → приложение не врёт');
  edge.kill('SIGTERM'); await sleep(2500);
  await page.waitForTimeout(13000);
  await step('через ~15 с без связи данные помечены «нет свежих данных»', async () => {
    const st = await page.evaluate(() => { const s = window.DDXAI.ui.snap(); return { empty: !!s.empty, stale: !!s.stale }; });
    assert.ok(st.empty || st.stale, JSON.stringify(st));
  });
  await page.waitForTimeout(22000);
  await step('через ~35 с старые цифры убраны, показано «нет данных от камер»', async () => {
    const st = await page.evaluate(() => { const s = window.DDXAI.ui.snap(); return { empty: !!s.empty, txt: document.querySelector('[data-screen="live"]').innerText.slice(0, 600), cams: document.querySelector('[data-camsline]').textContent }; });
    assert.equal(st.empty, true, JSON.stringify(st)); assert.match(st.txt, /Нет данных от камер/); assert.match(st.cams, /нет связи/);
  });
} finally {
  if (browser) await browser.close();
  try { edge.kill('SIGKILL'); } catch (e) { /* уже остановлен */ }
}
console.log(failed ? `\n${failed} провалено из ${n + failed}` : `\nВсе проверки пройдены: ${n}`);
process.exit(failed ? 1 : 0);
