/* Сквозная проверка: видео видит только администратор точки, обычное приложение — никогда.
   Поднимает настоящий сервер edge на видео, открывает приложение посетителя и админ-приложение в браузере.
   Запуск:  DDX_PY=путь/к/python DDX_MODEL=путь/к/yolox_tiny.onnx DDX_IMAGE=путь/к/фото_с_людьми.jpg node tests/admin-live.mjs */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let chromium; try { ({ chromium } = await import('playwright')); } catch (e) { ({ chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs')); }
const PY = process.env.DDX_PY || 'python3', MODEL = process.env.DDX_MODEL, IMAGE = process.env.DDX_IMAGE, MP = 8799, AP = 8798;
if (!MODEL || !IMAGE) { console.error('Нужны DDX_MODEL и DDX_IMAGE'); process.exit(2); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddx-admin-e2e-')), CLIP = path.join(tmp, 'clip.mp4'), PW = 'e2e-secret-pass-77';
const env = { ...process.env, DDX_ADMINS_FILE: path.join(tmp, 'admins.json'), DDX_AUDIT_FILE: path.join(tmp, 'audit.log'), DDX_E2E_PW: PW };
const mk = spawnSync(PY, ['-c', `
import cv2, sys
img = cv2.resize(cv2.imread(sys.argv[1]), (1280, 720))
vw = cv2.VideoWriter(sys.argv[2], cv2.VideoWriter_fourcc(*'mp4v'), 10, (1280, 720))
for i in range(60): vw.write(img)
vw.release()`, IMAGE, CLIP]);
if (mk.status !== 0) { console.error('не удалось сделать тестовое видео', String(mk.stderr)); process.exit(2); }
const add = spawnSync(PY, [path.join(root, 'edge/ddx_edge.py'), '--add-admin', 'e2e-admin', '--password-env', 'DDX_E2E_PW'], { env });
if (add.status !== 0) { console.error('не удалось создать администратора', String(add.stdout), String(add.stderr)); process.exit(2); }

const edge = spawn(PY, [path.join(root, 'edge/ddx_edge.py'), '--source', CLIP, '--port', String(MP), '--admin-port', String(AP), '--model', MODEL, '--fps', '4'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; edge.stdout.on('data', d => out += d); edge.stderr.on('data', d => out += d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0, failed = 0, browser;
const step = async (name, fn) => { try { await fn(); n++; console.log('  ok  ' + name); } catch (e) { failed++; console.error('  FAIL ' + name + '\n     ' + String(e.message).split('\n').slice(0, 6).join('\n     ')); } };

try {
  for (let i = 0; i < 80; i++) { await sleep(500); try { const j = await (await fetch(`http://127.0.0.1:${MP}/v1/occupancy`)).json(); if (j.zones && j.zones.length) break; } catch (e) { /* ждём запуск */ } }
  assert.match(out, /Админ-приложение \(видео/, 'админ-приложение не запустилось\n' + out);

  console.log('— без входа видео не отдаётся');
  await step('админ-API без входа: 401, поток видео: 401', async () => { for (const p of ['/api/me', '/api/cameras', '/api/cameras/cam1/stream.mjpg', '/api/audit']) assert.equal((await fetch(`http://127.0.0.1:${AP}${p}`)).status, 401, p); });
  await step('на порту посетителей админки и видео нет', async () => { for (const p of ['/admin/', '/api/cameras', '/api/cameras/cam1/stream.mjpg', '/snapshot.jpg']) assert.equal((await fetch(`http://127.0.0.1:${MP}${p}`)).status, 404, p); });
  await step('файлы с паролями и журналом не раздаются', async () => { for (const p of ['/admins.json', '/audit.log', '/edge/admins.json']) { assert.notEqual((await fetch(`http://127.0.0.1:${AP}${p}`)).status, 200, p); assert.notEqual((await fetch(`http://127.0.0.1:${MP}${p}`)).status, 200, p); } });

  browser = await chromium.launch({ args: ['--no-sandbox'] });
  console.log('— приложение посетителя (LIVE)');
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const member = await mctx.newPage(); const mreq = [];
  member.on('request', r => mreq.push(r.url()));
  await member.goto(`http://127.0.0.1:${MP}/#live`, { waitUntil: 'load' });
  await member.waitForFunction(() => window.DDXAI && window.DDXAI.orch.mode === 'LIVE', null, { timeout: 15000 }).catch(() => {});
  await member.waitForTimeout(2500);
  await step('в LIVE роль посетителя заблокирована и не повышается', async () => {
    const r = await member.evaluate(() => { const P = window.DDXAI.privacy; P.setRole('manager'); return { role: P.role, locked: P.locked, cam: P.can('camera', 'chest'), cmd: P.can('command') }; });
    assert.deepEqual(r, { role: 'member', locked: true, cam: false, cmd: false });
  });
  await step('Command Center в приложении посетителя недоступен и отправляет в приложение администратора', async () => {
    await member.evaluate(() => window.DDX.go('command')); await member.waitForTimeout(1200);
    const txt = await member.evaluate(() => document.querySelector('[data-screen="command"]').innerText);
    assert.match(txt, /DDX Vision Admin/); assert.ok(!/Войти как управляющий/.test(txt), txt.slice(0, 300));
  });
  await step('приложение посетителя не обращалось ни к видео, ни к админке', async () => {
    const bad = mreq.filter(u => /stream\.mjpg|\/api\/cameras|:8798|\.jpg(\?|$)|\.mjpg/i.test(u)); assert.deepEqual(bad, []);
  });

  console.log('— админ-приложение');
  const actx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const admin = await actx.newPage(); const aerr = [];
  admin.on('console', m => { if (m.type() === 'error' && !/401|Failed to load resource/.test(m.text())) aerr.push(m.text()); }); admin.on('pageerror', e => aerr.push('PAGEERROR: ' + e.message));
  if (process.env.DDX_DEBUG) admin.on('response', async r => { if (/\/api\/(login|me)/.test(r.url())) console.log('   [net]', r.request().method(), r.url().replace(/^.*:\d+/, ''), r.status(), (await r.text().catch(() => '')).slice(0, 120)); });
  await admin.goto(`http://127.0.0.1:${AP}/`, { waitUntil: 'load' });
  await step('виден только вход, консоли нет', async () => { await admin.waitForSelector('#loginForm', { state: 'visible' }); assert.equal(await admin.isHidden('#console'), true); if (process.env.DDX_SHOT) await admin.screenshot({ path: process.env.DDX_SHOT + '.login.png' }); });
  await step('неверный пароль: ошибка, консоль не открылась', async () => {
    await admin.fill('#fUser', 'e2e-admin'); await admin.fill('#fPass', 'wrong-password-123'); await admin.click('#loginBtn');
    await admin.waitForSelector('#loginErr', { state: 'visible' }); assert.match(await admin.textContent('#loginErr'), /Неверный/); assert.equal(await admin.isHidden('#console'), true);
  });
  await step('верный пароль: консоль точки открыта', async () => {
    await admin.fill('#fUser', 'e2e-admin'); await admin.fill('#fPass', PW); await admin.click('#loginBtn');
    await admin.waitForSelector('#console', { state: 'visible', timeout: 12000 }).catch(async e => { console.log('   [dbg]', JSON.stringify(await admin.evaluate(() => ({ url: location.href, user: document.querySelector('#fUser').value, passLen: document.querySelector('#fPass').value.length, btnDisabled: document.querySelector('#loginBtn').disabled, btnText: document.querySelector('#loginBtn').textContent, err: document.querySelector('#loginErr').textContent, loginHidden: document.querySelector('#login').hidden, active: document.activeElement && document.activeElement.id }))));  throw e; });
    assert.match(await admin.textContent('#who'), /e2e-admin/); assert.match(await admin.textContent('.notice'), /запись не ведётся/i);
  });
  await step('живой кадр с камеры показывается только после «Включить просмотр»', async () => {
    assert.equal(await admin.locator('.view img').count(), 0);
    await admin.click('.cam .btn--teal');
    await admin.waitForFunction(() => { const i = document.querySelector('.view img'); return i && i.naturalWidth > 100; }, null, { timeout: 15000 });
    await admin.evaluate(() => scrollTo(0, 0)); await admin.screenshot({ path: process.env.DDX_SHOT ? process.env.DDX_SHOT + '.top.png' : path.join(tmp, 'admin.png') });
  });
  await step('люди в зонах видны администратору', async () => { await admin.waitForSelector('#zones .zone', { timeout: 8000 }); assert.ok(await admin.locator('#zones .zone').count() >= 1); });
  await step('в журнале записан вход и просмотр', async () => { await admin.click('[data-tab="audit"]'); await admin.waitForFunction(() => /Начат просмотр · cam1/.test(document.querySelector('#audit').textContent), null, { timeout: 10000 }); const t = await admin.textContent('#audit'); assert.match(t, /Вход/); });
  await step('журнал на диске есть, паролей и видео в нём нет', async () => {
    const log = fs.readFileSync(path.join(tmp, 'audit.log'), 'utf8'); assert.match(log, /view\.start/); assert.ok(!log.includes(PW)); assert.ok(!/jpeg|base64/i.test(log));
    const adm = fs.readFileSync(path.join(tmp, 'admins.json'), 'utf8'); assert.ok(!adm.includes(PW));
  });
  await step('выход: снова только вход, видео запросить нельзя', async () => {
    await admin.click('#logout'); await admin.waitForSelector('#loginForm', { state: 'visible' });
    const st = await admin.evaluate(async () => (await fetch('/api/cameras/cam1/stream.mjpg', { credentials: 'same-origin' })).status); assert.equal(st, 401);
  });
  await step('в консоли админки нет ошибок (в том числе нарушений CSP)', async () => { assert.deepEqual(aerr, []); });
} finally {
  if (browser) await browser.close();
  try { edge.kill('SIGTERM'); } catch (e) { /* уже остановлен */ }
  await sleep(800); try { edge.kill('SIGKILL'); } catch (e) { /* ок */ }
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failed) console.log('\n--- вывод сервера ---\n' + out.slice(-2500));
console.log(failed ? `\n${failed} провалено из ${n + failed}` : `\nВсе проверки пройдены: ${n}`);
process.exit(failed ? 1 : 0);
