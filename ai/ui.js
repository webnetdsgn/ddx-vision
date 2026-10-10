/* =====================================================================
   DDX Vision — интерфейс AI-слоя, часть 1:
   запуск оркестратора, карточка на главной, экран AI LIVE (цифровой двойник клуба,
   прогноз перегрузок, карта оборудования), листы зоны, режима DEMO/LIVE и приватности.
   Встраивается в приложение через мост window.DDX; существующие экраны не трогает.
   ===================================================================== */
(function () {
  'use strict';
  const B = window.DDX, AI = window.DDXAI;
  if (!B || !AI) { console.error('DDX Vision AI: мост или ядро не загружены'); return; }
  const { $, $$, clamp, hm, plural } = B, esc = AI.util.esc, LEVEL = AI.LEVEL, EQST = AI.EQST, ZBY = AI.ZBY, ZDEF = AI.ZDEF;
  const UI = AI.ui = { prefs: { tab: 'map', layers: { heat: true, eq: true, ppl: true }, equip: 'ALL', profile: 'pro', limits: [] }, screens: {} };
  const PKEY = 'ddx-vision-ai';

  /* ---------- сохранение настроек (только безопасное: без токенов) ---------- */
  try { const s = JSON.parse(localStorage.getItem(PKEY) || 'null'); if (s) { Object.assign(UI.prefs, s.prefs || {}); AI.privacy.import(s.privacy); } } catch (e) { /* без хранилища тоже работаем */ }
  UI.persist = function () { try { localStorage.setItem(PKEY, JSON.stringify({ prefs: UI.prefs, privacy: AI.privacy.export() })); } catch (e) { /* ничего страшного */ } };

  /* ---------- оркестратор ---------- */
  const sim = AI.makeSim(B), orch = AI.orch = new AI.Orchestrator(sim);
  const offlineIds = () => orch.providers.equipment.ids ? orch.providers.equipment.ids('OFFLINE') : [];
  sim.markUnavailable(offlineIds()); // OFFLINE-станции в старых экранах тоже недоступны
  B.hooks.sim.push(() => sim.markUnavailable(offlineIds()));
  let snap = orch.update(0);
  UI.snap = () => snap;

  /* ---------- общие кусочки разметки ---------- */
  const lvChip = l => `<span class="lvchip lv-${l}">${l}</span>`;
  const eqChip = s => `<span class="eqchip" style="--c:${EQST[s].c}"><i></i>${s.replace('_', ' ')}</span>`;
  const modeBadge = () => `<button class="ai-badge ${orch.mode === 'LIVE' ? 'is-live' : 'is-demo'}" type="button" data-aimode>${orch.mode === 'LIVE' ? '<i></i>LIVE' : 'DEMO'}</button>`;
  const NAV = [['live', 'AI LIVE'], ['coach', 'Vision Coach'], ['twin', 'Body Twin'], ['command', 'Command Center']];
  const navHtml = cur => `<div class="chips ai-nav rv">${NAV.map(([k, n]) => `<button type="button" class="chip${k === cur ? ' is-on' : ''}" data-act="${k}">${n}</button>`).join('')}</div>`;
  const pct = p => Math.round(p * 100);
  const zname = id => ZBY[id].ru;
  UI.lvChip = lvChip; UI.eqChip = eqChip; UI.modeBadge = modeBadge; UI.navHtml = navHtml; UI.zname = zname; UI.pct = pct;
  const noData = () => snap.empty ? `<div class="empty rv"><b>Нет данных от камер</b><br>${esc(snap.error || 'Источник не подключён')}. Включите DEMO или проверьте подключение LIVE.<br><button class="btn btn--g btn--sm" type="button" data-aimode style="margin-top:12px">Режим данных</button></div>` : '';
  UI.noData = noData;

  /* ============================================================ Digital Twin: схема клуба */
  const TZ = { cardio: [8, 8, 344, 74], free: [8, 90, 168, 160], legs: [184, 90, 168, 50], chest: [184, 146, 168, 50], back: [184, 202, 168, 48], func: [8, 258, 168, 94], stretch: [184, 258, 80, 94], group: [272, 258, 80, 94], locker: [8, 360, 344, 52], entrance: [110, 420, 140, 42] };
  const NS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); Object.keys(attrs || {}).forEach(k => e.setAttribute(k, attrs[k])); if (parent) parent.appendChild(e); return e; };
  let twinSeq = 0;
  class Twin {
    constructor(svg, o) {
      this.svg = svg; this.o = o || {}; this.uid = ++twinSeq; this.layers = o.layers || UI.prefs.layers; this.dots = {}; this.eqEls = {}; this.zEls = {}; this.sel = null; this.active = false; this.build();
      svg.addEventListener('click', e => { const z = e.target.closest('[data-tz]'); if (z && this.o.onZone) this.o.onZone(z.dataset.tz); });
      svg.addEventListener('keydown', e => { if (e.key !== 'Enter' && e.key !== ' ') return; const z = e.target.closest('[data-tz]'); if (z && this.o.onZone) { e.preventDefault(); this.o.onZone(z.dataset.tz); } });
    }
    build() {
      const S = this.svg, u = this.uid; S.innerHTML = '';
      const defs = sv('defs', {}, S);
      const f = sv('filter', { id: 'twb' + u, x: '-30%', y: '-30%', width: '160%', height: '160%' }, defs); sv('feGaussianBlur', { stdDeviation: '11' }, f);
      const g = sv('linearGradient', { id: 'tws' + u, x1: 0, y1: 0, x2: 0, y2: 1 }, defs); sv('stop', { offset: 0, 'stop-color': '#03D1D6', 'stop-opacity': 0 }, g); sv('stop', { offset: 0.5, 'stop-color': '#03D1D6', 'stop-opacity': 0.26 }, g); sv('stop', { offset: 1, 'stop-color': '#03D1D6', 'stop-opacity': 0 }, g);
      this.heat = sv('g', { class: 'tw-heat', filter: 'url(#twb' + u + ')' }, S);
      ZDEF.forEach(z => {
        const [x, y, w, h] = TZ[z.id], narrow = w < 100 && h > 60, grp = sv('g', { class: 'tz', 'data-tz': z.id, role: 'button', tabindex: 0, 'aria-label': z.ru }, S), E = {};
        E.heat = sv('ellipse', { cx: x + w / 2, cy: y + h / 2, rx: w * 0.62, ry: h * 0.62 }, this.heat);
        E.r = sv('rect', { class: 'tz-r', x, y, width: w, height: h, rx: 14 }, grp);
        const n = sv('text', { class: 'tz-n', x: x + 9, y: y + 15 }, grp); n.textContent = z.ru.toUpperCase();
        E.p = sv('text', narrow ? { class: 'tz-p big', x: x + 9, y: y + h - 28 } : { class: 'tz-p', x: x + w - 9, y: y + 17, 'text-anchor': 'end' }, grp); E.p.textContent = '0%';
        E.f = sv('text', narrow ? { class: 'tz-f', x: x + 9, y: y + h - 12 } : { class: 'tz-f', x: x + w - 9, y: y + 29, 'text-anchor': 'end' }, grp);
        E.eq = sv('g', { class: 'tz-eq' }, grp); E.ppl = sv('g', { class: 'tz-ppl' }, grp);
        sv('rect', { class: 'tz-hit', x, y, width: w, height: h }, grp);
        E.g = grp; this.zEls[z.id] = E; this.dots[z.id] = [];
      });
      // вход
      const [ex, ey, ew] = TZ.entrance; sv('path', { class: 'tw-door', d: `M${ex + ew / 2 - 22} ${ey + 52} h44` }, S);
      this.scan = sv('rect', { class: 'tw-scan', x: 0, y: -70, width: 360, height: 70, fill: 'url(#tws' + u + ')' }, S);
      this.eqBuilt = false;
    }
    buildEq(items) { // станции — по зонам, сеткой
      const byZ = {}; items.forEach(i => { (byZ[i.zone] = byZ[i.zone] || []).push(i); });
      ZDEF.forEach(z => {
        const E = this.zEls[z.id], list = (byZ[z.id] || []).slice().sort((a, b) => (a.type === b.type ? a.n - b.n : a.type < b.type ? -1 : 1)); E.eq.innerHTML = '';
        const [x, y, w, h] = TZ[z.id], pitch = 14; let cx = x + 9, cy = y + 28; const maxX = x + w - 9; E.eqRows = list.length ? 1 : 0;
        list.forEach(i => {
          const wide = i.slots ? 36 : 10; if (cx + wide > maxX) { cx = x + 9; cy += pitch; E.eqRows++; }
          const r = sv('rect', { class: 'eqd', x: cx, y: cy, width: wide, height: 10, rx: 3.5, 'data-eqd': i.id }, E.eq); const t = sv('title', {}, r); t.textContent = i.name + ' №' + i.n; this.eqEls[i.id] = r;
          cx += wide + 4;
        });
      });
      this.eqBuilt = true;
    }
    // где можно рисовать точки-людей, чтобы не закрывать подписи и станции
    region(id) {
      const [x, y, w, h] = TZ[id], narrow = w < 100 && h > 60, top = narrow ? y + 24 : this.zEls[id].eqRows ? y + 28 + this.zEls[id].eqRows * 14 + 6 : y + 26;
      return [x + 10, top, x + w - 10, narrow ? y + h - 48 : y + h - 8];
    }
    update(s) {
      if (!s || s.empty) return;
      if (!this.eqBuilt || this.eqN !== s.eq.items.length) { this.buildEq(s.eq.items); this.eqN = s.eq.items.length; }
      ZDEF.forEach(z0 => {
        const z = s.zoneById[z0.id], E = this.zEls[z0.id];
        if (!z) { // источник не передал эту зону — честно показываем «нет данных»
          E.r.style.stroke = '#9AA8AA'; E.r.style.fill = '#9AA8AA'; E.r.style.fillOpacity = 0.05; E.heat.style.opacity = 0; E.p.textContent = '—'; E.p.style.fill = '#7A8A8C'; E.f.textContent = ''; E.g.classList.remove('is-crit');
          const a0 = this.dots[z0.id]; while (a0.length) a0.pop().el.remove(); return;
        }
        const L = LEVEL[z.level], hot = z.level === 'CRITICAL';
        E.r.style.stroke = L.c; E.r.style.fill = L.c; E.r.style.fillOpacity = (0.05 + z.p * 0.13).toFixed(3);
        E.heat.style.fill = L.c; E.heat.style.opacity = (0.06 + z.p * 0.4).toFixed(3);
        E.p.textContent = pct(z.p) + '%'; E.p.style.fill = L.t;
        const d = Math.round((z.p15 - z.p) * 100); E.f.textContent = this.o.compact || !z.hasEq ? '' : '+15′ ' + pct(z.p15) + '%'; E.f.style.fill = z.level15 !== z.level && LEVEL[z.level15].rank > L.rank ? LEVEL[z.level15].t : '';
        E.g.classList.toggle('is-crit', hot); E.g.classList.toggle('is-sel', this.sel === z.id);
        E.g.setAttribute('aria-label', z.ru + ': ' + pct(z.p) + '%, ' + z.level);
        // обезличенные точки-люди
        const reg = this.region(z.id), area = Math.max(1, (reg[2] - reg[0]) * (reg[3] - reg[1])), want = Math.min(z.count, Math.floor(area / 230), 26), arr = this.dots[z.id];
        while (arr.length < want) { const px = reg[0] + Math.random() * (reg[2] - reg[0]), py = reg[1] + Math.random() * Math.max(1, reg[3] - reg[1]); const el = sv('circle', { r: 2.3, cx: px, cy: py }, E.ppl); arr.push({ el, x: px, y: py, tx: px, ty: py }); }
        while (arr.length > want) { const q = arr.pop(); q.el.remove(); }
      });
      s.eq.items.forEach(i => { const r = this.eqEls[i.id]; if (!r) return; const st = i.status; if (r._s !== st) { r._s = st; r.setAttribute('class', 'eqd s-' + st); } if (i.slots) { r.style.opacity = '1'; } });
      this.svg.classList.toggle('no-heat', !this.layers.heat); this.svg.classList.toggle('no-eq', !this.layers.eq || !!this.o.compact); this.svg.classList.toggle('no-ppl', !this.layers.ppl);
    }
    select(id) { this.sel = id; Object.keys(this.zEls).forEach(k => this.zEls[k].g.classList.toggle('is-sel', k === id)); }
    frame() {
      if (!this.active || !this.layers.ppl) return;
      ZDEF.forEach(z => {
        const reg = this.region(z.id);
        this.dots[z.id].forEach(d => {
          if (Math.hypot(d.tx - d.x, d.ty - d.y) < 1 || Math.random() < 0.003) { d.tx = reg[0] + Math.random() * (reg[2] - reg[0]); d.ty = reg[1] + Math.random() * Math.max(1, reg[3] - reg[1]); }
          d.x += (d.tx - d.x) * 0.014; d.y += (d.ty - d.y) * 0.014; d.el.setAttribute('cx', d.x.toFixed(1)); d.el.setAttribute('cy', d.y.toFixed(1));
        });
      });
    }
  }
  UI.Twin = Twin; UI.TZ = TZ;

  /* ============================================================ карточка на главной */
  const homeHost = $('[data-ailive]');
  function renderHomeCard() {
    if (!homeHost) return;
    if (snap.empty) { B.setH(homeHost, `<button class="aic" type="button" data-go="live"><span class="aic-top"><span class="aic-t"><i class="ai-dot"></i>AI LIVE</span><span class="ai-badge is-live">LIVE</span></span><b class="aic-h">Нет данных камер</b><span class="aic-f">Откройте, чтобы выбрать источник</span></button>`); return; }
    const top = snap.zones.filter(z => z.hasEq).sort((a, b) => b.p - a.p).slice(0, 3), nc = snap.traffic.nextCritical;
    const foot = nc ? (nc.inMin === 0 ? 'Критичная загрузка сейчас: «' + zname(nc.zone) + '»' : 'Критичная загрузка через ' + nc.inMin + ' мин: «' + zname(nc.zone) + '»') : 'Перегрузок в ближайшие 30 минут не ожидается';
    B.setH(homeHost, `<button class="aic" type="button" data-go="live"><span class="aic-top"><span class="aic-t"><i class="ai-dot"></i>AI LIVE</span><span class="ai-badge ${orch.mode === 'LIVE' ? 'is-live' : 'is-demo'}">${orch.mode === 'LIVE' ? 'LIVE' : 'DEMO'}</span></span>
      <b class="aic-h">Цифровой двойник клуба</b>
      <span class="aic-z">${top.map(z => `<span class="aic-r"><em>${z.ru}</em><span class="aic-b"><i style="width:${pct(z.p)}%;background:${LEVEL[z.level].c}"></i></span><u>${pct(z.p)}%</u></span>`).join('')}</span>
      <span class="aic-f ${nc ? 'warn' : ''}">${foot}<svg class="ico"><use href="#i-right"/></svg></span></button>`);
  }

  /* ============================================================ экран AI LIVE */
  const host = $('[data-live]');
  let twin = null, built = false;
  const HEADZ = ['free', 'legs', 'cardio', 'func'];
  function buildLive() {
    host.innerHTML = `
      <div class="ai-head rv"><div><h2 class="h-title">AI LIVE</h2><p class="h-sub">Цифровой двойник клуба в реальном времени</p></div>${modeBadge()}</div>
      ${navHtml('live')}
      <div data-a-nodata></div>
      <div class="ai-hero rv" data-a-hero>
        <div class="ai-hero-top"><span class="ai-label">CLUB STATUS</span><span class="ai-upd"><i class="ai-dot"></i><span data-a="upd">live</span></span></div>
        <div class="ai-stats"><div><small>PEOPLE INSIDE</small><b class="num" data-a="people">0</b></div><div><small>CLUB LOAD</small><b class="num" data-a="load">0<em>%</em></b></div></div>
        <div class="ai-zrows">${HEADZ.map(id => `<button type="button" class="ai-zr" data-zr="${id}"><span class="ai-zn">${zname(id)}</span><span class="ai-zb"><i></i></span><b class="num">0%</b><span class="lvchip">LOW</span></button>`).join('')}</div>
        <p class="ai-sum" data-a="sum"></p>
      </div>
      <div class="seg ai-seg rv" data-seg="aitab"><span class="seg-ink"></span><button type="button" data-v="map">Карта</button><button type="button" data-v="forecast">Прогноз</button><button type="button" data-v="equip">Тренажёры</button></div>
      <div data-aipane="map" class="rv">
        <div class="map-card tw-card"><svg class="tw-svg" viewBox="0 0 360 470" data-twsvg aria-label="Цифровой двойник клуба"></svg>
          <div class="tw-layers" data-twl>${[['heat', 'Heat'], ['eq', 'Станции'], ['ppl', 'Люди']].map(([k, n]) => `<button type="button" class="chip" data-l="${k}">${n}</button>`).join('')}</div>
          <div class="map-legend tw-leg">${['LOW', 'NORMAL', 'BUSY', 'CRITICAL'].map(l => `<span><i style="background:${LEVEL[l].c}"></i>${l}</span>`).join('')}</div>
        </div>
        <p class="ai-foot">Нажмите на зону — покажем людей, время на станции и прогноз. Люди показаны обезличенными точками.</p>
      </div>
      <div data-aipane="forecast" class="rv" hidden></div>
      <div data-aipane="equip" class="rv" hidden></div>
      <div class="ai-tiles rv">
        <button type="button" class="ai-tile" data-act="coach"><span class="ai-ti"><svg class="ico"><use href="#i-eye"/></svg></span><b>Vision Coach</b><small>техника движений</small></button>
        <button type="button" class="ai-tile" data-act="twin"><span class="ai-ti"><svg class="ico"><use href="#i-heart"/></svg></span><b>Body Twin</b><small>ваш прогресс</small></button>
        <button type="button" class="ai-tile" data-act="command"><span class="ai-ti"><svg class="ico"><use href="#i-gauge"/></svg></span><b>Command Center</b><small>для управляющего</small></button>
      </div>
      <p class="ai-foot rv" data-a="foot"></p>`;
    twin = UI.twin = new Twin($('[data-twsvg]', host), { onZone: id => openZone(id) });
    $$('[data-twl] [data-l]', host).forEach(b => b.classList.toggle('is-on', !!UI.prefs.layers[b.dataset.l]));
    built = true;
  }
  const foot = () => orch.mode === 'LIVE' ? 'Данные: боевые источники клуба. Прогноз — по типовому дню, пока нет накопленной истории.' : 'DEMO · данные симулированы по тем же контрактам, что и боевые. Подключение настоящих камер и оборудования — в «Режиме данных».';
  function renderLive(full) {
    if (!built) buildLive();
    B.setH($('[data-a-nodata]', host), snap.empty ? noData() : '');
    const s = snap; $$('[data-aimode]', host).forEach(b => { b.className = 'ai-badge ' + (orch.mode === 'LIVE' ? 'is-live' : 'is-demo'); b.innerHTML = orch.mode === 'LIVE' ? '<i></i>LIVE' : 'DEMO'; });
    $('[data-a="foot"]', host).textContent = foot();
    if (s.empty) return;
    B.tweenNum($('[data-a="people"]', host), s.people); B.tweenNum($('[data-a="load"]', host), pct(s.load), 0, '<em>%</em>');
    $('[data-a="upd"]', host).textContent = s.mode === 'LIVE' ? (s.stale ? 'нет свежих данных' : 'live') : 'демо' + (s.scenario ? ' · сценарий' : '');
    HEADZ.forEach(id => { const z = s.zoneById[id], r = $(`[data-zr="${id}"]`, host); if (!r) return; if (!z) { $('.ai-zb i', r).style.width = '0%'; $('b', r).textContent = '—'; const c0 = $('.lvchip', r); c0.textContent = 'NO DATA'; c0.className = 'lvchip'; return; } $('.ai-zb i', r).style.width = pct(z.p) + '%'; $('.ai-zb i', r).style.background = LEVEL[z.level].c; $('b', r).textContent = pct(z.p) + '%'; const c = $('.lvchip', r); c.textContent = z.level; c.className = 'lvchip lv-' + z.level; });
    $('[data-a="sum"]', host).textContent = s.summary;
    twin.layers = UI.prefs.layers; twin.update(s);
    const tab = UI.prefs.tab; $$('[data-aipane]', host).forEach(p => { p.hidden = p.dataset.aipane !== tab; });
    $$('[data-seg="aitab"] button', host).forEach(b => b.classList.toggle('is-on', b.dataset.v === tab)); B.layoutSeg($('[data-seg="aitab"]', host));
    $$('[data-twl] [data-l]', host).forEach(b => b.classList.toggle('is-on', !!UI.prefs.layers[b.dataset.l]));
    if (tab === 'forecast') renderForecastPane(); else if (tab === 'equip') renderEquipPane();
  }
  host.addEventListener('click', e => {
    const t = e.target, tab = t.closest('[data-seg="aitab"] button');
    if (tab) { UI.prefs.tab = tab.dataset.v; UI.persist(); B.buzz(5); renderLive(); return; }
    const l = t.closest('[data-twl] [data-l]'); if (l) { UI.prefs.layers[l.dataset.l] = !UI.prefs.layers[l.dataset.l]; UI.persist(); B.buzz(4); renderLive(); return; }
    const z = t.closest('[data-zr]'); if (z) { openZone(z.dataset.zr); return; }
    const m = t.closest('[data-aimode]'); if (m) { openMode(); return; }
    const q = t.closest('[data-eqopen]'); if (q) { B.openEq(q.dataset.eqopen); return; }
    const f = t.closest('[data-eqf]'); if (f) { UI.prefs.equip = f.dataset.eqf; UI.persist(); B.buzz(4); renderLive(); return; }
  });

  /* ---------- прогноз перегрузок ---------- */
  function critBanner(s) {
    const nc = s.traffic.nextCritical;
    return nc ? `<div class="ai-crit ${nc.inMin === 0 ? 'now' : ''}"><span class="ai-label">${nc.inMin === 0 ? 'CRITICAL LOAD NOW' : 'CRITICAL LOAD IN'}</span>${nc.inMin === 0 ? '' : `<b class="num">${nc.inMin}<em> MIN</em></b>`}<small>«${zname(nc.zone)}» · прогноз ${pct(s.zoneById[nc.zone].p15)}% через 15 мин</small></div>`
      : `<div class="ai-crit ok"><span class="ai-label">PREDICTED CONGESTION</span><b class="num">OK</b><small>В ближайшие 30 минут критичной загрузки не ожидается</small></div>`;
  }
  function pcCard(list) {
    const rows = list.map(z => `<button type="button" class="pc-row" data-zr="${z.id}"><span class="pc-n">${z.ru}${z.p15 - z.p > 0.02 ? '<em class="up">↗</em>' : z.p15 - z.p < -0.02 ? '<em class="dn">↘</em>' : ''}</span><span class="pc-v"><i><u style="width:${pct(z.p)}%;background:${LEVEL[z.level].c}"></u></i><small>сейчас ${pct(z.p)}%</small></span><span class="pc-v"><i><u style="width:${pct(z.p15)}%;background:${LEVEL[z.level15].c}"></u></i><small>+15′ ${pct(z.p15)}%</small></span><span class="pc-v"><i><u style="width:${pct(z.p30)}%;background:${LEVEL[z.level30].c}"></u></i><small>+30′ ${pct(z.p30)}%</small></span></button>`).join('');
    return `<div class="card pc-card"><div class="pc-h"><span></span><small>сейчас</small><small>+15′</small><small>+30′</small></div>${rows}</div>`;
  }
  const recCards = s => s.traffic.recs.map(r => `<div class="ai-rec"><b>${r.text}</b><p>«${zname(r.from)}» ${pct(s.zoneById[r.from].p15)}% → «${zname(r.to)}»: свободно ещё ${r.spare} ${plural(r.spare, ['место', 'места', 'мест'])}. Ожидание тренажёра сократится примерно на ${Math.max(1, Math.round(r.savedMin))} мин.</p></div>`).join('');
  UI.critBanner = critBanner; UI.pcCard = pcCard; UI.recCards = recCards;
  function renderForecastPane() {
    const s = snap, pane = $('[data-aipane="forecast"]', host), list = s.zones.filter(z => z.hasEq).sort((a, b) => b.p15 - a.p15).slice(0, 5), recs = recCards(s);
    B.setH(pane, critBanner(s) + pcCard(list) + (recs ? `<h3 class="ai-h3">Рекомендации AI</h3>${recs}` : '') + `<p class="ai-foot">Прогноз строится по текущим счётчикам и типовому дню клуба. Решения о перенаправлении принимает человек.</p>`);
  }

  /* ---------- карта оборудования ---------- */
  function renderEquipPane() {
    const s = snap, pane = $('[data-aipane="equip"]', host), f = UI.prefs.equip, c = s.eq.counts;
    const order = { QUEUE: 0, IN_USE: 1, AVAILABLE: 2, UNKNOWN: 3, OFFLINE: 4, MAINTENANCE: 5 };
    const items = s.eq.items.filter(i => f === 'ALL' || i.status === f).sort((a, b) => order[a.status] - order[b.status] || a.zone.localeCompare(b.zone) || a.n - b.n).slice(0, 40);
    const chips = ['ALL', 'AVAILABLE', 'IN_USE', 'QUEUE', 'OFFLINE', 'MAINTENANCE', 'UNKNOWN'].map(k => `<button type="button" class="chip${f === k ? ' is-on' : ''}" data-eqf="${k}">${k === 'ALL' ? 'ALL ' + s.eq.total : k.replace('_', ' ') + ' ' + (c[k] || 0)}</button>`).join('');
    const rows = items.map(i => `<button type="button" class="eqx" data-eqopen="${i.id}"><span class="eqx-n"><b>${i.name}${i.slots ? '' : ' №' + i.n}</b><small>${zname(i.zone)}${i.slots ? ' · ' + (i.slots.cap - i.slots.used) + ' из ' + i.slots.cap + ' мест' : ''}</small></span>${eqChip(i.status)}<span class="eqx-t">${i.status === 'IN_USE' || i.status === 'QUEUE' ? '~' + i.etaMin + ' мин' : i.status === 'AVAILABLE' ? 'сейчас' : ''}</span></button>`).join('');
    B.setH(pane, `<div class="chips ai-fl">${chips}</div><div class="eql ai-eql">${rows || '<div class="empty">Нет станций с таким статусом</div>'}</div><p class="ai-foot">Статусы приходят от камер и датчиков через EquipmentProvider. Нет прямой телеметрии — станция помечается UNKNOWN, а не угадывается.</p>`);
  }

  /* ============================================================ лист зоны */
  function openZone(id) {
    twin && twin.select(id);
    const html = () => {
      const z = snap.zoneById && snap.zoneById[id]; if (!z) return '<div class="empty">Нет данных по зоне</div>';
      const d = ZBY[id], items = snap.eq.items.filter(i => i.zone === id), rec = snap.traffic.recs.find(r => r.from === id || r.to === id), L = LEVEL[z.level];
      return `<h3 class="sh-title">${d.en}</h3><p class="sh-sub">${d.ru} · ${lvChip(z.level)} ${L.ru.toLowerCase()}</p>
        <div class="eq-grid"><div class="eg"><small>PEOPLE NOW</small><b>${z.count} <i>чел.</i></b></div><div class="eg"><small>CAPACITY INDICATOR</small><b>${pct(z.p)}<i>%</i></b></div><div class="eg"><small>AVG DWELL TIME</small><b>${Math.round(z.dwell)} <i>мин</i></b></div><div class="eg"><small>PREDICTION +15 MIN</small><b style="color:${LEVEL[z.level15].t}">${pct(z.p15)}<i>%</i></b></div></div>
        <div class="zs-bars">${[['сейчас', z.p, z.level], ['+15′', z.p15, z.level15], ['+30′', z.p30, z.level30]].map(([n, p, l]) => `<div class="zs-b"><small>${n}</small><i><u style="width:${pct(p)}%;background:${LEVEL[l].c}"></u></i><b class="num">${pct(p)}%</b></div>`).join('')}</div>
        ${z.hasEq ? `<div class="ai-note"><svg class="ico"><use href="#i-clock"/></svg><span>${z.wait15 >= 1 ? 'Ожидание тренажёра через 15 минут ≈ <b style="color:var(--text)">' + Math.round(z.wait15) + ' мин</b>.' : 'Очередей к тренажёрам в этой зоне не ожидается.'}</span></div>` : ''}
        ${rec ? `<div class="ai-rec"><b>${rec.text}</b><p>${rec.from === id ? 'Из этой зоны' : 'В эту зону'} можно направить часть тренирующихся: ${rec.to === id ? 'здесь' : 'в «' + zname(rec.to) + '»'} свободнее.</p></div>` : ''}
        ${items.length ? `<h4 class="ai-h4">Станции зоны</h4><div class="zs-eq">${items.slice(0, 14).map(i => `<button type="button" class="eqx" data-eqopen="${i.id}"><span class="eqx-n"><b>${i.name}${i.slots ? '' : ' №' + i.n}</b></span>${eqChip(i.status)}<span class="eqx-t">${i.status === 'IN_USE' || i.status === 'QUEUE' ? '~' + i.etaMin + ' мин' : ''}</span></button>`).join('')}</div>` : ''}
        <p class="ai-foot" style="margin-top:12px">${AI.privacy.cameraZones[id] ? 'Зона видна камерам: только счётчики и силуэты, лица не распознаются.' : 'В этой зоне камер нет — считаем по замкам и расписанию.'}</p>`;
    };
    B.openSheet(html(), 'aizone', () => { if (B.sheet.classList.contains('is-on') && B.sheetB.querySelector('.zs-bars')) { const h = html(); if (B.sheetB._zh !== h) { B.sheetB._zh = h; B.sheetB.innerHTML = h; } } });
    B.sheetB._zh = B.sheetB.innerHTML;
  }
  UI.openZone = openZone;
  B.sheetB.addEventListener('click', e => { const q = e.target.closest('[data-eqopen]'); if (q) B.openEq(q.dataset.eqopen); });

  /* ============================================================ режим данных DEMO / LIVE */
  function openMode() {
    const html = () => {
      const live = orch.mode === 'LIVE', P = orch.providers, st = k => P[k] && P[k].status ? P[k].status() : { state: 'ok' };
      const row = (name, k, desc) => { const s = st(k); return `<div class="pv-row"><b>${name}</b><small>${desc}</small><span class="pv-s ${live ? (s.state === 'ok' ? 'ok' : 'err') : 'demo'}">${live ? (s.state === 'ok' ? 'LIVE' : 'ОШИБКА') : 'DEMO'}</span></div>`; };
      return `<h3 class="sh-title">Режим данных</h3><p class="sh-sub">DEMO использует симулятор с теми же контрактами, что и боевые источники</p>
        <div class="seg" data-seg="mode" style="margin-bottom:14px"><span class="seg-ink"></span><button type="button" class="${live ? '' : 'is-on'}" data-mode="DEMO">DEMO</button><button type="button" class="${live ? 'is-on' : ''}" data-mode="LIVE">LIVE</button></div>
        <div class="card pv-card">${row('CameraProvider', 'camera', 'занятость зон, потоки')}${row('EquipmentProvider', 'equipment', 'статусы станций')}
          <div class="pv-row"><b>IdentityProvider</b><small>браслет · NFC · QR · BLE</small><span class="pv-s demo">DEMO</span></div><div class="pv-row"><b>BodyCompositionProvider</b><small>InBody и др.</small><span class="pv-s demo">DEMO</span></div><div class="pv-row"><b>WorkoutProvider</b><small>история тренировок</small><span class="pv-s demo">DEMO</span></div><div class="pv-row"><b>PoseProvider</b><small>ключевые точки (edge)</small><span class="pv-s demo">DEMO</span></div></div>
        ${live ? `<div class="ai-note"><svg class="ico"><use href="#i-bolt"/></svg><span>Подключено: ${esc((orch.liveCfg || {}).baseUrl || '')}. Остальные источники пока в DEMO — в интерфейсе они помечены.</span></div><button class="btn btn--g btn--w" type="button" data-modego="DEMO">Вернуться в DEMO</button>`
          : `<h4 class="ai-h4">Подключить боевой сервис</h4><label class="fld"><small>Адрес API (https://…)</small><input type="url" inputmode="url" placeholder="https://vision.example.com" data-live-url autocomplete="off" value="${esc(AI.liveConfigHint.baseUrl)}"></label><label class="fld"><small>Токен доступа (хранится только в памяти страницы)</small><input type="password" placeholder="Bearer-токен" data-live-token autocomplete="off"></label>
          <button class="btn btn--o btn--w" type="button" data-livego>Проверить и подключить</button><p class="ai-foot" data-live-msg style="margin-top:10px">Без адреса и ключей LIVE включить нельзя: данные не придумываются. Контракт API — в docs/AI-ENGINE.md.</p>`}`;
    };
    B.openSheet(html(), 'aimode', () => { /* форму не перерисовываем во время ввода */ });
    UI.refreshMode = () => { if (B.sheet.classList.contains('is-on')) { B.sheetB.innerHTML = html(); B.layoutSeg($('[data-seg="mode"]', B.sheetB)); } };
    setTimeout(() => B.layoutSeg($('[data-seg="mode"]', B.sheetB)), 30);
  }
  UI.openMode = openMode;
  B.sheetB.addEventListener('click', async e => {
    const m = e.target.closest('[data-mode]'), g = e.target.closest('[data-modego]'), l = e.target.closest('[data-livego]');
    if (m && m.dataset.mode === 'DEMO' && orch.mode === 'LIVE') { orch.setDemo(); orch.attachScenario(orch.scen); snap = orch.update(0); UI.refreshMode(); B.toast('DEMO: данные симулированы'); return; }
    if (g) { orch.setDemo(); orch.attachScenario(orch.scen); snap = orch.update(0); UI.refreshMode(); B.toast('DEMO: данные симулированы'); return; }
    if (m && m.dataset.mode === 'LIVE' && orch.mode === 'DEMO') { B.toast('Для LIVE введите адрес и токен ниже'); const i = $('[data-live-url]', B.sheetB); if (i) i.focus(); return; }
    if (l) {
      const url = ($('[data-live-url]', B.sheetB).value || '').trim(), token = $('[data-live-token]', B.sheetB).value, msg = $('[data-live-msg]', B.sheetB);
      if (!/^https?:\/\//i.test(url)) { msg.textContent = 'Нужен полный адрес, например https://vision.example.com'; return; }
      msg.textContent = 'Проверяем подключение…'; l.disabled = true;
      try { AI.liveConfigHint.baseUrl = url; await orch.connectLive({ baseUrl: url, token }); AI.privacy.log('mode.live', 'подключён ' + url); snap = orch.update(0); UI.refreshMode(); B.toast('LIVE подключён'); }
      catch (err) { msg.textContent = 'Не удалось подключиться: ' + (err && err.message || err) + '. Остаёмся в DEMO.'; l.disabled = false; }
    }
  });

  /* #live — автоподключение к сервису с того же адреса. Нужно для прототипа edge/ddx_edge.py:
     один компьютер раздаёт и приложение, и /v1/occupancy, поэтому ни CORS, ни смешанного http/https нет. */
  if (/[#?&]live\b/.test(location.hash + location.search) && /^https?:$/.test(location.protocol)) {
    setTimeout(async () => {
      try { AI.liveConfigHint.baseUrl = location.origin; await orch.connectLive({ baseUrl: location.origin, token: '' }); AI.privacy.log('mode.live', 'подключён ' + location.origin); snap = orch.update(0); if (UI.refreshMode) UI.refreshMode(); B.toast('LIVE подключён'); B.go('live'); }
      catch (err) { B.toast('LIVE не подключился: ' + (err && err.message || err)); }
    }, 1600);
  }

  /* ============================================================ данные и согласия (приватность, аудит) */
  function openPrivacyAI() {
    const html = () => {
      const P = AI.privacy, c = P.consent, R = P.retention;
      const tg = (k, on, dis) => `<button class="toggle${on ? ' is-on' : ''}" type="button" data-cons="${k}" ${dis ? 'disabled style="opacity:.5"' : ''} aria-label="${k}"></button>`;
      const chipsDays = (k, vals) => vals.map(v => `<button type="button" class="chip${R[k] === v ? ' is-on' : ''}" data-ret="${k}:${v}">${v} дн.</button>`).join('');
      return `<h3 class="sh-title">Данные и согласия</h3><p class="sh-sub">PROCESS VIDEO — STORE DATA: видео обрабатывается на месте, хранятся только числа</p>
        <div class="pv-flow"><span>Камера</span><i>›</i><span class="a">Edge AI</span><i>›</i><span>Метаданные</span><i>›</i><span>Backend</span></div>
        <div class="card"><div class="row"><div><b>Vision Coach</b><small>Анализ движений в отмеченных зонах</small></div>${tg('coach', c.coach)}</div>
          <div class="row"><div><b>Источник: InBody</b><small>для Body Twin</small></div>${tg('inbody', c.sources.inbody)}</div>
          <div class="row"><div><b>Источник: история тренировок</b><small>для Body Twin</small></div>${tg('workouts', c.sources.workouts)}</div>
          <div class="row"><div><b>Источник: метрики Vision Coach</b><small>для Body Twin</small></div>${tg('srccoach', c.sources.coach)}</div>
          <div class="row"><div><b>Источник: восстановление</b><small>сон, пульс (не подключено)</small></div>${tg('recovery', c.sources.recovery, true)}</div></div>
        <h4 class="ai-h4">Сроки хранения</h4><div class="ret-row"><small>Аналитика зон</small><div class="chips">${chipsDays('analyticsDays', [30, 90, 180])}</div></div><div class="ret-row"><small>Ключевые точки движений</small><div class="chips">${chipsDays('keypointsDays', [7, 30, 90])}</div></div><div class="ret-row"><small>Сессии и Body Twin</small><div class="chips">${chipsDays('sessionDays', [180, 365, 730])}</div></div><div class="ret-row"><small>Видео</small><div class="chips"><span class="chip is-on">не хранится</span></div></div>
        <h4 class="ai-h4">Камеры по зонам</h4><div class="cz-grid">${ZDEF.map(z => `<span class="cz ${P.cameraZones[z.id] ? 'on' : 'off'}">${z.ru}<small>${P.cameraZones[z.id] ? 'счётчики' : 'без камер'}</small></span>`).join('')}</div>
        <h4 class="ai-h4">Роль (демо)</h4><div class="chips" data-roles>${Object.keys(P.ROLES).map(r => `<button type="button" class="chip${P.role === r ? ' is-on' : ''}" data-role="${r}">${P.ROLES[r]}</button>`).join('')}</div>
        <h4 class="ai-h4">Журнал доступа</h4><div class="audit">${P.audit.slice(0, 7).map(a => `<div class="au"><b>${esc(a.action)}</b><span>${esc(a.detail)}</span><small>${new Date(a.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} · ${P.ROLES[a.role]}</small></div>`).join('') || '<div class="empty">Записей пока нет</div>'}</div>
        <button class="btn btn--g btn--w" type="button" data-deldata style="margin-top:14px">Удалить мои данные в этом демо</button>
        <p class="ai-foot" style="margin-top:10px">Шифрование, роли и журнал аудита — часть архитектуры; в демо показан интерфейс. Соответствие требованиям законодательства требует отдельной юридической проверки.</p>`;
    };
    B.openSheet(html(), 'aipriv', () => { });
    UI.refreshPriv = () => { if (B.sheet.classList.contains('is-on') && B.sheetB.querySelector('.pv-flow')) B.sheetB.innerHTML = html(); };
  }
  UI.openPrivacyAI = openPrivacyAI;
  B.sheetB.addEventListener('click', e => {
    const P = AI.privacy, c = e.target.closest('[data-cons]'), r = e.target.closest('[data-ret]'), ro = e.target.closest('[data-role]'), d = e.target.closest('[data-deldata]');
    if (c) { const k = c.dataset.cons; if (k === 'coach') P.consent.coach = !P.consent.coach; else if (k === 'srccoach') P.consent.sources.coach = !P.consent.sources.coach; else P.consent.sources[k] = !P.consent.sources[k]; P.log('consent.' + k, (k === 'coach' ? P.consent.coach : P.consent.sources[k === 'srccoach' ? 'coach' : k]) ? 'дано' : 'отозвано'); UI.persist(); UI.refreshPriv(); if (UI.onConsent) UI.onConsent(); B.buzz(6); }
    if (r) { const [k, v] = r.dataset.ret.split(':'); P.retention[k] = +v; P.log('retention.set', k + ' = ' + v + ' дн.'); UI.persist(); UI.refreshPriv(); }
    if (ro) { P.setRole(ro.dataset.role); UI.persist(); UI.refreshPriv(); B.render(true); }
    if (d) { P.consent.coach = false; Object.assign(P.consent.sources, { inbody: true, workouts: true, coach: true, recovery: false }); UI.prefs.limits = []; try { localStorage.removeItem(PKEY); } catch (er) { /* нет хранилища */ } P.log('data.delete', 'локальные данные и согласия удалены'); UI.refreshPriv(); if (UI.onConsent) UI.onConsent(); B.toast('Данные удалены. Согласия сброшены.'); }
  });

  /* ============================================================ подключение к жизненному циклу приложения */
  const enter = {};
  UI.enter = enter;
  enter.live = () => { if (!built) buildLive(); twin.active = true; renderLive(true); setTimeout(() => B.layoutSeg($('[data-seg="aitab"]', host)), 40); };
  const prevOnGo = B.onGo;
  B.onGo = name => { if (prevOnGo) prevOnGo(name); if (twin) twin.active = name === 'live'; if (UI.twinCmd) UI.twinCmd.active = name === 'command'; if (enter[name]) enter[name](); };
  B.acts.live = () => B.go('live');
  B.acts.mode = () => openMode();
  B.acts.privacyai = () => openPrivacyAI();
  // шапка главной: в LIVE пишем то, что сообщил сервис, а не цифры демо-клуба
  function syncHeader() {
    const cn = $('[data-clubname]'), cl = $('[data-camsline]'); if (!cn || !cl) return;
    if (orch.mode === 'LIVE') {
      const f = orch.providers.camera.frame || {};
      cn.textContent = f.clubName || 'Боевой сервис';
      cl.textContent = snap.empty ? 'нет связи · live' : (f.cameras && f.cameras.total ? f.cameras.online + ' из ' + f.cameras.total + ' камер · live' : 'live');
    } else { cn.textContent = B.state.club.name; cl.textContent = B.state.club.cams + ' камер · live'; }
  }
  B.hooks.tick.push(() => { snap = orch.update(); syncHeader(); });
  B.hooks.render.push(full => {
    renderHomeCard();
    if (B.state.screen === 'live') renderLive(full);
    const sc = UI.screens[B.state.screen]; if (sc && sc.render) sc.render(full);
  });
  B.hooks.frame.push(t => {
    if (twin && B.state.screen === 'live') twin.frame(t);
    if (UI.twinCmd && B.state.screen === 'command') UI.twinCmd.frame(t);
    const sc = UI.screens[B.state.screen]; if (sc && sc.frame) sc.frame(t);
  });
  addEventListener('resize', () => { if (B.state.screen === 'live') B.layoutSeg($('[data-seg="aitab"]', host)); });
  UI.snapNow = () => snap; UI.setSnap = s => { snap = s; };
  UI.refresh = () => { snap = orch.update(0); B.render(true); };
  renderHomeCard();
})();
