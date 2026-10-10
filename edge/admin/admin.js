/* DDX Vision Admin — интерфейс администратора точки. Без внешних библиотек и без inline-кода (строгая CSP).
   Все данные из сервера вставляются через textContent. */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const EVT = { 'login.ok': 'Вход', 'login.fail': 'Неудачный вход', 'login.blocked': 'Блокировка перебора', 'logout': 'Выход', 'view.start': 'Начат просмотр', 'view.end': 'Просмотр завершён' };
  const state = { idleLeft: 0, timers: [], viewing: {} };

  async function api(path, opts) {
    opts = opts || {};
    const init = { credentials: 'same-origin', cache: 'no-store', method: opts.method || 'GET', headers: {} };
    if (init.method === 'POST') { init.headers['X-DDX-Admin'] = '1'; init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body || {}); }
    try { const r = await fetch(path, init); let data = null; try { data = await r.json(); } catch (e) { /* пустой ответ */ } return { status: r.status, data: data || {} }; }
    catch (e) { return { status: 0, data: { error: 'Нет связи с сервером точки' } }; }
  }

  function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; }
  function showLogin(msg) {
    clearTimers(); stopAllViews();
    $('#console').hidden = true; $('#login').hidden = false;
    const err = $('#loginErr'); err.hidden = !msg; err.textContent = msg || '';
    $('#fPass').value = ''; $('#loginBtn').disabled = false; setTimeout(() => $('#fUser').focus(), 50);
  }

  async function boot() {
    const me = await api('/api/me');
    if (me.status === 200) showConsole(me.data); else showLogin();
  }

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#loginBtn'); btn.disabled = true; btn.textContent = 'Проверяем…';
    const r = await api('/api/login', { method: 'POST', body: { user: $('#fUser').value.trim(), password: $('#fPass').value } });
    btn.textContent = 'Войти';
    if (r.status === 200) { const me = await api('/api/me'); if (me.status === 200) { showConsole(me.data); return; } }
    showLogin(r.data.error || 'Не удалось войти');
  });

  function showConsole(me) {
    $('#login').hidden = true; $('#console').hidden = false;
    $('#club').textContent = me.club || 'Точка'; $('#who').textContent = me.user;
    state.idleLeft = me.idleLeftSec; paintIdle();
    loadCameras(); loadZones(); loadAudit();
    clearTimers();
    state.timers.push(setInterval(loadZones, 2000), setInterval(loadCamStates, 5000), setInterval(() => { state.idleLeft = Math.max(0, state.idleLeft - 1); paintIdle(); if (state.idleLeft <= 0) checkSession('Сессия завершена из-за бездействия'); }, 1000), setInterval(syncMe, 20000));
  }

  async function syncMe() { const me = await api('/api/me'); if (me.status === 200) { state.idleLeft = me.data.idleLeftSec; } else showLogin('Сессия завершена. Войдите снова.'); }
  async function checkSession(msg) { const me = await api('/api/me'); if (me.status !== 200) showLogin(msg || 'Сессия завершена. Войдите снова.'); else { state.idleLeft = me.data.idleLeftSec; paintIdle(); } }
  function paintIdle() { const m = Math.floor(state.idleLeft / 60), s = state.idleLeft % 60; $('#idle').textContent = 'сессия: ' + m + ':' + String(s).padStart(2, '0'); }

  // любое действие пользователя продлевает сессию (не чаще раза в 20 с)
  let lastPing = 0;
  ['click', 'keydown', 'touchstart'].forEach(ev => addEventListener(ev, () => { const t = Date.now(); if (t - lastPing < 20000 || $('#console').hidden) return; lastPing = t; api('/api/ping', { method: 'POST' }).then(r => { if (r.status === 200) { state.idleLeft = r.data.idleLeftSec; } }); }, { passive: true }));

  $('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); showLogin(); });
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('is-on', x === t));
    $('#tab-cams').hidden = t.dataset.tab !== 'cams'; $('#tab-audit').hidden = t.dataset.tab !== 'audit';
    if (t.dataset.tab === 'audit') loadAudit();
  }));

  /* ---- камеры ---- */
  let camList = [];
  async function loadCameras() {
    const r = await api('/api/cameras'); if (r.status !== 200) { showLogin('Сессия завершена. Войдите снова.'); return; }
    camList = r.data.cameras || []; const host = $('#cams'); host.textContent = '';
    if (!camList.length) host.appendChild(el('p', 'empty', 'Камеры не настроены.'));
    camList.forEach(c => host.appendChild(camCard(c)));
  }
  async function loadCamStates() {
    const r = await api('/api/cameras'); if (r.status !== 200) return;
    (r.data.cameras || []).forEach(c => { const chip = $('[data-st="' + c.name + '"]'); if (chip) paintState(chip, c.state); });
  }
  function paintState(chip, st) { chip.textContent = st === 'online' ? 'в сети' : 'нет сигнала'; chip.className = 'chip ' + (st === 'online' ? 'chip--ok' : 'chip--bad'); }

  function camCard(c) {
    const card = el('div', 'cam');
    const h = el('div', 'cam-h'); h.appendChild(el('b', null, c.name)); const chip = el('span', 'chip'); chip.dataset.st = c.name; paintState(chip, c.state); h.appendChild(chip); card.appendChild(h);
    const view = el('div', 'view', 'Просмотр выключен'); card.appendChild(view);
    const f = el('div', 'cam-f');
    const lab = el('label'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = true; lab.appendChild(cb); lab.appendChild(document.createTextNode('Показать рамки ИИ и зоны')); f.appendChild(lab);
    const btn = el('button', 'btn btn--teal btn--sm', 'Включить просмотр'); btn.type = 'button'; f.appendChild(btn); card.appendChild(f);
    btn.addEventListener('click', () => { if (state.viewing[c.name]) stopView(c.name, view, btn); else startView(c.name, view, btn, cb.checked); });
    cb.addEventListener('change', () => { if (state.viewing[c.name]) { stopView(c.name, view, btn); startView(c.name, view, btn, cb.checked); } });
    return card;
  }
  function startView(name, view, btn, overlay) {
    view.textContent = ''; const img = new Image(); img.alt = 'Живой кадр камеры ' + name; img.decoding = 'async';
    img.addEventListener('error', () => { if (state.viewing[name]) { view.textContent = 'Нет сигнала или сессия завершена'; delete state.viewing[name]; btn.textContent = 'Включить просмотр'; checkSession(); } });
    img.src = '/api/cameras/' + encodeURIComponent(name) + '/stream.mjpg?overlay=' + (overlay ? 1 : 0) + '&t=' + Date.now();
    view.appendChild(img); state.viewing[name] = img; btn.textContent = 'Выключить просмотр';
    setTimeout(loadAudit, 1200);
  }
  function stopView(name, view, btn) {
    const img = state.viewing[name]; if (img) { img.removeAttribute('src'); } delete state.viewing[name];
    view.textContent = 'Просмотр выключен'; btn.textContent = 'Включить просмотр'; setTimeout(loadAudit, 1200);
  }
  function stopAllViews() { Object.keys(state.viewing).forEach(n => { try { state.viewing[n].removeAttribute('src'); } catch (e) { /* уже убран */ } }); state.viewing = {}; }

  /* ---- люди в зонах ---- */
  const ZN = { free: 'Свободные веса', legs: 'Ноги', chest: 'Грудь', back: 'Спина', cardio: 'Кардио', func: 'Функционал', stretch: 'Растяжка', group: 'Групповые', entrance: 'Вход' };
  async function loadZones() {
    const r = await api('/api/occupancy'); if (r.status !== 200) return;
    const host = $('#zones'); host.textContent = ''; const zs = r.data.zones || [];
    if (!zs.length) { host.appendChild(el('p', 'empty', 'Данных пока нет: камеры не передают кадры или идёт первый расчёт.')); return; }
    zs.forEach(z => {
      const d = el('div', 'zone' + (z.p >= 0.95 ? ' is-crit' : z.p >= 0.7 ? ' is-busy' : ''));
      d.appendChild(el('small', null, ZN[z.id] || z.id)); d.appendChild(el('b', null, z.count + ' / ' + z.capacity));
      const bar = el('i'); const fill = el('s'); fill.style.width = Math.round(Math.min(1, z.p) * 100) + '%'; bar.appendChild(fill); d.appendChild(bar); host.appendChild(d);
    });
  }

  /* ---- журнал ---- */
  async function loadAudit() {
    const r = await api('/api/audit?limit=60'); if (r.status !== 200) return;
    const host = $('#audit'); host.textContent = ''; const ev = r.data.events || [];
    if (!ev.length) { host.appendChild(el('p', 'empty', 'Событий пока нет.')); return; }
    ev.forEach(e => {
      const row = el('div', 'au'); const t = el('time', null, new Date(e.ts * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      row.appendChild(t); row.appendChild(el('b', null, (EVT[e.event] || e.event) + (e.camera ? ' · ' + e.camera : ''))); row.appendChild(el('span', null, (e.user || '—') + ' · ' + (e.ip || '')));
      host.appendChild(row);
    });
  }

  boot();
})();
