/* =====================================================================
   DDX Vision — интерфейс AI-слоя, часть 2:
   Command Center управляющего (за 10 секунд понять клуб) и динамический маршрут тренировки
   (встраивается в существующий режим тренировки).
   ===================================================================== */
(function () {
  'use strict';
  const B = window.DDX, AI = window.DDXAI, UI = AI && AI.ui;
  if (!B || !AI || !UI) return;
  const { $, $$, hm, plural, clamp } = B, esc = AI.util.esc, LEVEL = AI.LEVEL, EQST = AI.EQST, ZBY = AI.ZBY, ZDEF = AI.ZDEF, orch = AI.orch, P = AI.privacy;
  const pct = UI.pct, zname = UI.zname, hash = AI.util.hash;
  const IC = n => `<svg class="ico" style="width:18px;height:18px"><use href="#${n}"/></svg>`;

  /* ============================================================ COMMAND CENTER */
  const host = $('[data-command]');
  let built = false, ccTwin = null;
  const cmdLog = [], acked = new Set();
  const SUG = ['Что сейчас происходит в клубе?', 'Какие проблемы были сегодня?', 'Где сейчас свободно?', 'Когда будет пик?', 'Что с оборудованием?', 'Покажи итоги дня'];
  const retSummary = s => { const c = AI.Return.cohort(B.state.club.id, Math.round((s.clubCap || 130) * 9)); return c; };

  function build() {
    host.innerHTML = `
      <div class="ai-head rv"><div><h2 class="h-title">COMMAND CENTER</h2><p class="h-sub">DDX Vision · <span data-c="club"></span></p></div>${UI.modeBadge()}</div>
      ${UI.navHtml('command')}
      <div data-c-gate hidden></div>
      <div data-c-body>
        <div class="ai-hero cc-sum rv" data-cs="sum"></div>
        <div class="cc-kpis rv" data-cs="kpi"></div>
        <div class="sec rv"><div class="sec-h"><h3>Live heatmap</h3><button type="button" data-act="live">AI LIVE</button></div><div class="map-card tw-card cc-map"><svg class="tw-svg" viewBox="0 0 360 470" data-ccsvg aria-label="Тепловая карта клуба"></svg></div></div>
        <div class="sec rv"><div class="sec-h"><h3>Predicted congestion</h3></div><div data-cs="pred"></div></div>
        <div class="sec rv"><div class="sec-h"><h3>Equipment status</h3></div><div data-cs="eq"></div></div>
        <div class="sec rv"><div class="sec-h"><h3>Traffic</h3></div><div data-cs="traffic"></div></div>
        <div class="sec rv"><div class="sec-h"><h3>Vision events</h3><small class="sec-n" data-cs-n="events"></small></div><div data-cs="events"></div></div>
        <div class="sec rv"><div class="sec-h"><h3>Operational alerts</h3></div><div data-cs="alerts"></div></div>
        <div class="sec rv"><div class="sec-h"><h3>Return engine</h3></div><div data-cs="ret"></div></div>
        <div class="sec rv"><div class="sec-h"><h3>Ask DDX AI</h3></div>
          <div class="cc-ask"><div class="chips cc-sug">${SUG.map(q => `<button type="button" class="chip" data-ccq="${esc(q)}">${esc(q)}</button>`).join('')}</div><div class="cc-log" data-cc-log></div>
          <form class="cc-form" data-cc-form><input type="text" placeholder="Спросите про клуб…" autocomplete="off" aria-label="Вопрос для DDX AI" data-cc-in><button type="submit" class="send" aria-label="Отправить">${IC('i-send')}</button></form></div></div>
        <div class="sec rv"><div class="sec-h"><h3>Daily AI report</h3></div><div data-cs="report"></div></div>
        <div class="sec rv cc-foot"><button class="btn btn--g btn--w" type="button" data-act="privacyai">${IC('i-shield')}Данные, роли и журнал доступа</button><button class="btn btn--g btn--w" type="button" data-go="admin">${IC('i-cam')}Камеры и сигналы (классический пульт)</button><button class="btn btn--g btn--w" type="button" data-act="home">Вернуться к режиму посетителя</button></div>
      </div>`;
    ccTwin = UI.twinCmd = new UI.Twin($('[data-ccsvg]', host), { compact: true, layers: { heat: true, eq: false, ppl: true }, onZone: id => UI.openZone(id) });
  }
  B.acts.home = () => B.go('home');

  const kpiCell = (label, val, sub, color) => `<div class="kpi cc-k"><small>${label}</small><b class="num"${color ? ` style="color:${color}"` : ''}>${val}</b><span>${sub}</span></div>`;
  function sumHtml(s) {
    const d = B.DAYS_F[s.clock.dow], t = hm(s.clock.min);
    return `<div class="ai-hero-top"><span class="ai-label">TODAY · ${d.toUpperCase()} ${t}</span><span class="ai-upd"><i class="ai-dot"></i>${s.mode === 'LIVE' ? 'live' : 'демо' + (s.scenario ? ' · сценарий' : '')}</span></div><p class="cc-line">${esc(s.summary)}</p>`;
  }
  function kpiHtml(s) {
    const k = s.kpis, L = LEVEL[AI.levelOf(s.load)], pk = s.peak, cz = s.critical.map(z => zname(z.id));
    return kpiCell('PEOPLE INSIDE', k.people, 'из ' + s.clubCap) + kpiCell('CLUB LOAD', pct(s.load) + '%', L.ru.toLowerCase(), L.t) + kpiCell('PEAK PREDICTION', pk ? hm(pk.min) : '—', pk ? '≈' + pct(pk.load) + '% типового' : 'пик пройден')
      + kpiCell('CRITICAL ZONES', k.critical, cz.length ? cz.join(', ') : 'нет', k.critical ? LEVEL.CRITICAL.t : '') + kpiCell('EQUIPMENT ALERTS', k.eqAlerts, k.eqAlerts ? 'требуют внимания' : 'всё в норме', k.eqAlerts ? LEVEL.BUSY.t : '') + kpiCell('AI OPERATIONAL EVENTS', k.aiEvents, 'за сегодня');
  }
  function eqHtml(s) {
    const c = s.eq.counts, tot = Math.max(1, s.eq.total), order = ['AVAILABLE', 'IN_USE', 'QUEUE', 'OFFLINE', 'MAINTENANCE', 'UNKNOWN'];
    return `<div class="card eq-card"><div class="eq-stack">${order.map(k => c[k] ? `<i style="flex:${c[k]};background:${EQST[k].c}" title="${k}"></i>` : '').join('')}</div><div class="eq-leg">${order.map(k => `<span><i style="background:${EQST[k].c}"></i>${k.replace('_', ' ')}<b>${c[k] || 0}</b></span>`).join('')}</div></div>`;
  }
  function trafficHtml(s) {
    const tr = s.traffic, flows = s.flows.slice(0, 3), e = s.entrance;
    const fl = flows.map(f => `<div class="tf"><span>${zname(f.from)} <em>→</em> ${zname(f.to)}</span><b class="num">${f.per10}</b><small>чел. / 10 мин</small></div>`).join('');
    const rec = tr.recs[0], effect = tr.effect;
    return `<div class="card cc-tr"><div class="tf-io"><div><small>ВХОД · 10 мин</small><b class="num">+${e.in10}</b></div><div><small>ВЫХОД · 10 мин</small><b class="num">−${e.out10}</b></div><div><small>ВНУТРИ</small><b class="num">${s.people}</b></div></div>${fl ? `<div class="tf-list">${fl}</div>` : ''}</div>
      ${rec ? `<div class="ai-rec"><b>${rec.text}</b><p>«${zname(rec.from)}» → «${zname(rec.to)}»: прогноз нагрузки −${Math.round(rec.shift * 100)} п.п., ожидание ≈ −${Math.max(1, Math.round(rec.savedMin))} мин.</p>
        <div class="row cc-auto"><div><b>Auto-redistribute traffic</b><small>${orch.auto ? (tr.steered != null && tr.steered < 1 ? 'эффект нарастает…' : 'включено: подсказки уходят в приложения') : 'выключено: решение за вами'}</small></div><button class="toggle${orch.auto ? ' is-on' : ''}" type="button" data-cc-auto aria-label="Автоматическое перераспределение потока"></button></div>
        ${orch.auto && effect ? `<p class="cc-eff">Оценка модели: ожидание сокращено ≈ на ${Math.max(1, Math.round(effect.savedMin))} мин. Это прогноз, а не измерение.</p>` : ''}</div>` : '<div class="empty">Перераспределение сейчас не требуется</div>'}`;
  }
  const EVI = { congestion: 'i-users', occupancy: 'i-spark', queue: 'i-clock', equipment: 'i-machine' };
  function eventsHtml(s) {
    const ev = s.activeEvents.filter(e => e.type !== 'equipment' && !acked.has(e.id)).sort((a, b) => (b.sev === 'action') - (a.sev === 'action') || b.dur - a.dur).slice(0, 5);
    if (!ev.length) return '<div class="empty">Сейчас всё спокойно. Событий, требующих внимания, нет.</div>';
    return ev.map(e => `<div class="al ${e.sev === 'action' ? 'bad' : e.sev === 'watch' ? 'warn' : 'info'}"><span class="ai">${IC(EVI[e.type] || 'i-spark')}</span><div><span class="ai-tag">AI EVENT</span><b>${esc(e.title)}</b><p>${esc(e.detail || '')}</p><div class="ev-meta"><span>Длительность: ${Math.max(1, Math.round(e.dur))} мин</span><span>${zname(e.zone)}</span></div><div class="al-a"><button type="button" class="pri" data-evcam="${e.zone}" data-evid="${e.id}">Открыть камеру</button><button type="button" data-evack="${e.id}">Принято</button></div></div></div>`).join('');
  }
  function alertsHtml(s) {
    const out = s.eq.alerts.filter(a => !acked.has('eq:' + a.eq + a.kind)).map(a => `<div class="al ${a.kind === 'long' ? 'warn' : a.kind === 'offline' ? 'info' : 'bad'}"><span class="ai">${IC('i-machine')}</span><div><b>${esc(a.title)}</b><p>${esc(a.detail)}</p><div class="al-a"><button type="button" class="pri" data-eqopen="${a.eq}">Открыть станцию</button><button type="button" data-evack="eq:${a.eq}${a.kind}">Принято</button></div></div></div>`);
    const n = B.now(), cl = B.CLASSES.find(c => c[0] + c[3] > n.min && c[0] + c[3] - n.min <= 20 && c[0] <= n.min);
    if (cl) out.push(`<div class="al info"><span class="ai">${IC('i-locker')}</span><div><b>Скоро поток в раздевалки</b><p>Через ${Math.round(cl[0] + cl[3] - n.min)} мин закончится «${cl[1]}». Ожидается до ${Math.round(clamp(B.loadAt(n.dow, cl[0]) * 24 + 3, 6, 22))} человек.</p></div></div>`);
    return out.join('') || '<div class="empty">Оповещений по оборудованию нет</div>';
  }
  function retHtml(s) {
    if (!P.can('retention')) return '<div class="empty">Раздел доступен управляющему</div>';
    const c = retSummary(s), tot = c.size, R = AI.Return.SIGNAL, names = { NORMAL: 'NORMAL', WATCH: 'WATCH', DECLINING: 'DECLINING ENGAGEMENT' };
    const bars = ['NORMAL', 'WATCH', 'DECLINING'].map(k => `<div class="rt"><span>${names[k]}</span><i><u style="width:${(c.counts[k] / tot * 100).toFixed(1)}%;background:${R[k].c}"></u></i><b class="num">${c.counts[k]}</b></div>`).join('');
    const fl = c.flagged.slice(0, 3).map(f => `<div class="au"><b>${f.id}</b><span>${f.daysSince} ${plural(f.daysSince, ['день', 'дня', 'дней'])} без визита · ${f.why.slice(1).join(', ') || 'частота визитов снизилась'}</span></div>`).join('');
    return `<div class="card"><div class="rt-list">${bars}</div><p class="ai-foot" style="margin:10px 0 0">Обезличенная сводка по ${tot} ${plural(tot, ['участнику', 'участникам', 'участникам'])} (демо). Сотрудники видят только сигнал и номер, без диагнозов и личных данных.</p></div>
      <div class="ai-rec"><b>Мягкое возвращение</b><p>Участникам с сигналом DECLINING приложение предложит короткую тренировку со сниженной стартовой нагрузкой (WELCOME BACK).</p><div class="al-a"><button type="button" class="pri" data-cc-camp>Подготовить рассылку (демо)</button></div></div>
      ${fl ? `<div class="audit" style="margin-top:8px">${fl}</div>` : ''}`;
  }
  function reportHtml(s) {
    const f = s.report.facts, tz = zname(f.topZone);
    return `<div class="card rp-card"><div class="rp-grid"><div><small>PEAK OCCUPANCY</small><b class="num">${f.peakPct}%</b></div><div><small>PEAK TIME</small><b class="num">${hm(f.peakTime)}</b></div><div><small>MOST LOADED ZONE</small><b class="rp-z">${tz}</b></div><div><small>AVERAGE CONGESTION</small><b class="num">${String(f.avgWait).replace('.', ',')}<em> мин</em></b></div><div><small>EQUIPMENT ALERTS</small><b class="num">${f.eqAlerts}</b></div><div><small>AI EVENTS</small><b class="num">${s.kpis.aiEvents}</b></div></div>
      <p class="rp-sum">${esc(s.report.summary)}</p><div class="al-a"><button type="button" class="pri" data-cc-copy>Скопировать текст</button></div><p class="ai-foot" style="margin:8px 0 0">${orch.mode === 'LIVE' ? 'Отчёт пока построен по типовому дню клуба: накопленной истории событий нет.' : 'Отчёт собран по модели дня и событиям системы (демо).'} Резюме пересказывает посчитанные числа и не добавляет новых.</p></div>`;
  }
  const gateHtml = () => P.locked
    ? `<div class="card cc-gate rv"><b>Command Center — только для администраторов точки</b><p>Он открывается в отдельном приложении «DDX Vision Admin» по логину и паролю своей точки. В приложении посетителя его нет, видео с камер посетителям недоступно.</p></div>`
    : `<div class="card cc-gate rv"><b>Command Center доступен управляющему</b><p>В демо роль выбирается переключателем. В реальной системе управляющий работает в отдельном приложении «DDX Vision Admin»: вход по логину и паролю своей точки, у каждой точки они свои.</p><button class="btn btn--o btn--w" type="button" data-cc-login>Войти как управляющий (демо)</button></div>`;

  function renderLog() {
    const box = $('[data-cc-log]', host); if (!box) return;
    B.setH(box, cmdLog.map(m => m.q ? `<div class="cc-q">${esc(m.q)}</div><div class="cc-a"><span class="ai-tag">DDX AI</span>${esc(m.a.text).replace(/\n/g, '<br>')}${m.a.src && m.a.src.length ? `<div class="cc-src">${m.a.src.map(x => `<span>${x}</span>`).join('')}</div>` : ''}${m.a.report ? '<div class="al-a"><button type="button" class="pri" data-cc-rep>К отчёту</button></div>' : ''}</div>` : `<div class="cc-a sys"><span class="ai-tag">DDX AI</span>${esc(m.a.text)}${m.a.src ? `<div class="cc-src">${m.a.src.map(x => `<span>${x}</span>`).join('')}</div>` : ''}</div>`).join(''));
    box.scrollTop = box.scrollHeight;
  }
  UI.ccSay = (text, src) => { cmdLog.push({ sys: 1, a: { text, src: src || [] } }); if (cmdLog.length > 6) cmdLog.shift(); renderLog(); };
  function ask(q) {
    q = String(q || '').trim(); if (!q) return; const s = UI.snapNow();
    const a = AI.ask(q, s, s.empty ? null : retSummary(s)); cmdLog.push({ q, a }); if (cmdLog.length > 6) cmdLog.shift(); P.log('ai.ask', q.slice(0, 60)); renderLog(); B.buzz(6);
  }

  function renderCommand() {
    if (!built) { build(); built = true; }
    const s = UI.snapNow(), gate = !P.can('command');
    $('[data-c-gate]', host).hidden = !gate; $('[data-c-body]', host).hidden = gate;
    $$('[data-aimode]', host).forEach(b => { b.className = 'ai-badge ' + (orch.mode === 'LIVE' ? 'is-live' : 'is-demo'); b.innerHTML = orch.mode === 'LIVE' ? '<i></i>LIVE' : 'DEMO'; });
    if (gate) { B.setH($('[data-c-gate]', host), gateHtml()); return; }
    $('[data-c="club"]', host).textContent = s.clubName || B.state.club.name;
    if (s.empty) { B.setH($('[data-cs="sum"]', host), `<p class="cc-line">${esc(UI.noData ? 'Нет данных от камер. Проверьте источник в «Режиме данных».' : '')}</p>`); return; }
    B.setH($('[data-cs="sum"]', host), sumHtml(s)); B.setH($('[data-cs="kpi"]', host), kpiHtml(s));
    ccTwin.update(s);
    B.setH($('[data-cs="pred"]', host), UI.critBanner(s) + UI.pcCard(s.zones.filter(z => z.hasEq).sort((a, b) => b.p15 - a.p15).slice(0, 3)));
    B.setH($('[data-cs="eq"]', host), eqHtml(s)); B.setH($('[data-cs="traffic"]', host), trafficHtml(s));
    B.setH($('[data-cs="events"]', host), eventsHtml(s)); B.setH($('[data-cs="alerts"]', host), alertsHtml(s));
    $('[data-cs-n="events"]', host).textContent = s.activeEvents.filter(e => e.type !== 'equipment' && !acked.has(e.id)).length + ' активн.';
    B.setH($('[data-cs="ret"]', host), retHtml(s)); B.setH($('[data-cs="report"]', host), reportHtml(s));
  }
  UI.screens.command = { render: renderCommand };
  UI.enter.command = () => { if (ccTwin) ccTwin.active = true; renderCommand(); };
  B.acts.command = () => { if (!P.can('command')) { P.setRole('manager'); UI.persist(); B.toast('Демо: роль «Управляющий»'); } B.go('command'); };

  host.addEventListener('click', e => {
    const t = e.target, go = (sel, fn) => { const x = t.closest(sel); if (x) { fn(x); return true; } return false; };
    if (go('[data-aimode]', () => UI.openMode())) return;
    if (go('[data-cc-login]', () => { P.setRole('manager'); UI.persist(); renderCommand(); })) return;
    if (go('[data-cc-auto]', () => { orch.setAuto(!orch.auto); UI.refresh(); B.buzz(8); })) return;
    if (go('[data-ccq]', x => ask(x.dataset.ccq))) return;
    if (go('[data-evack]', x => { const id = x.dataset.evack; acked.add(id); if (id.indexOf('eq:') !== 0) orch.anom.ack(id); P.log('event.ack', id); B.buzz(6); renderCommand(); })) return;
    if (go('[data-evcam]', x => openCamera(x.dataset.evcam, x.dataset.evid))) return;
    if (go('[data-cc-camp]', () => { P.log('campaign.draft', 'WELCOME BACK · мягкое возвращение (демо)'); B.toast('Черновик рассылки сохранён (демо). Ничего не отправлено.'); })) return;
    if (go('[data-cc-copy]', () => { const s = UI.snapNow(); try { navigator.clipboard.writeText('DAILY CLUB INTELLIGENCE\n' + s.report.summary); B.toast('Текст отчёта скопирован'); } catch (er) { B.toast('Не удалось скопировать — выделите текст вручную'); } })) return;
    if (go('[data-cc-rep]', () => { const r = $('[data-cs="report"]', host); r && r.scrollIntoView({ behavior: 'smooth', block: 'center' }); })) return;
    if (go('[data-eqopen]', x => B.openEq(x.dataset.eqopen))) return;
    go('[data-zr]', x => UI.openZone(x.dataset.zr));
  });
  host.addEventListener('submit', e => { const f = e.target.closest('[data-cc-form]'); if (!f) return; e.preventDefault(); const i = $('[data-cc-in]', f); ask(i.value); i.value = ''; });

  /* ---------- просмотр камеры зоны: только с правами и с записью в журнал ---------- */
  function openCamera(zone, evId) {
    if (!P.can('camera', zone)) {
      P.log('camera.denied', zone + (evId ? ' · ' + evId : ''));
      B.openSheet(`<h3 class="sh-title">Камеры нет</h3><p class="sh-sub">${zname(zone)}</p><div class="ai-note"><svg class="ico"><use href="#i-shield"/></svg><span>${P.cameraZones[zone] === false ? 'В этой зоне камер нет по умолчанию (раздевалки, студия). Считаем по замкам и расписанию.' : (P.locked ? 'Видео с камер посетителям недоступно. Его видят только администраторы точки в отдельном приложении «DDX Vision Admin» (вход по логину и паролю).' : 'Для просмотра камер нужна роль «Тренер» или «Управляющий». В реальной системе — только в отдельном приложении администратора.')}</span></div>`, 'aicam'); return;
    }
    P.log('camera.open', zone + (evId ? ' · ' + evId : ''));
    B.openSheet(`<h3 class="sh-title">${zname(zone)}</h3><p class="sh-sub">Камера зоны · обработка на edge-сервере клуба</p><div class="zcam"><canvas data-zcam></canvas><span class="zcam-h"><i></i>ДЕМО-КАДР · симуляция</span><span class="zcam-f" data-zcam-f></span></div><div class="ai-note"><svg class="ico"><use href="#i-shield"/></svg><span>Лица скрыты, видео не записывается. Факт просмотра сохранён в журнале доступа.</span></div>`, 'aicam');
    const cv = $('[data-zcam]', B.sheetB), people = [];
    const loop = t => {
      if (!document.body.contains(cv)) return; requestAnimationFrame(loop);
      const s = UI.snapNow(), z = s.zoneById && s.zoneById[zone]; if (!z) return;
      const r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2), W = r.width, H = r.height; if (!W) return;
      if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#0a2a2f'); bg.addColorStop(1, '#03191c'); g.fillStyle = bg; g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(104,218,224,.09)'; const vy = H * 0.3; for (let k = -6; k <= 6; k++) { g.beginPath(); g.moveTo(W / 2 + k * W * 0.04, vy); g.lineTo(W / 2 + k * W * 0.24, H); g.stroke(); } for (let k = 1; k < 7; k++) { const yy = vy + (H - vy) * Math.pow(k / 7, 1.6); g.beginPath(); g.moveTo(0, yy); g.lineTo(W, yy); g.stroke(); }
      const want = Math.min(z.count, 14); while (people.length < want) people.push({ x: 0.1 + Math.random() * 0.8, y: 0.5 + Math.random() * 0.4, tx: 0.1 + Math.random() * 0.8, ty: 0.5 + Math.random() * 0.4, c: 0.88 + Math.random() * 0.11 }); people.length = want;
      people.forEach(p => {
        if (Math.hypot(p.tx - p.x, p.ty - p.y) < 0.01) { p.tx = 0.08 + Math.random() * 0.84; p.ty = 0.48 + Math.random() * 0.42; } p.x += (p.tx - p.x) * 0.01; p.y += (p.ty - p.y) * 0.01;
        const sc = 0.6 + p.y * 0.7, ph = H * 0.34 * sc, pw = ph * 0.38, px = p.x * W, py = p.y * H - ph;
        g.save(); g.filter = 'blur(2.5px)'; g.fillStyle = 'rgba(160,215,220,.55)'; g.beginPath(); g.arc(px, py + pw * 0.5, pw * 0.42, 0, 7); g.fill(); g.beginPath(); g.ellipse(px, py + ph * 0.6, pw * 0.55, ph * 0.38, 0, 0, 7); g.fill(); g.restore();
        g.strokeStyle = '#03D1D6'; g.lineWidth = 1.2; g.strokeRect(px - pw * 0.7, py, pw * 1.4, ph); g.fillStyle = '#03D1D6'; g.fillRect(px - pw * 0.7, py - 10, 14, 4);
      });
      const sy = (t / 18) % (H + 40) - 20, sg = g.createLinearGradient(0, sy - 20, 0, sy + 20); sg.addColorStop(0, 'rgba(18,216,216,0)'); sg.addColorStop(0.5, 'rgba(18,216,216,.14)'); sg.addColorStop(1, 'rgba(18,216,216,0)'); g.fillStyle = sg; g.fillRect(0, sy - 20, W, 40);
      const f = $('[data-zcam-f]', B.sheetB); if (f) f.textContent = z.count + ' чел. · лица скрыты · 0 байт видео сохранено';
    };
    requestAnimationFrame(loop);
  }
  UI.openCamera = openCamera;

  /* ============================================================ ДИНАМИЧЕСКИЙ МАРШРУТ ТРЕНИРОВКИ */
  const R = AI.Routing;
  const route = UI.route = { pos: { x: 180, y: 479 }, last: null, undo: null, hold: 0, lastAt: 0, ctxOverride: null };
  const unitName = id => { const it = UI.snapNow().eq.items.find(i => i.id === id); return it ? it.name + (it.slots ? '' : ' №' + it.n) : ''; };
  function ctx() {
    if (route.ctxOverride) return route.ctxOverride;
    const items = UI.snapNow().eq.items || [];
    return {
      goals: B.GOALS, mPerUnit: 0.1, limits: UI.prefs.limits || [], pos: route.pos, threshold: 3,
      wait(type) { let best = null; items.forEach(i => { if (i.type !== type) return; const w = i.status === 'AVAILABLE' ? 0 : (i.status === 'IN_USE' || i.status === 'QUEUE') ? i.etaMin : null; if (w == null) return; if (!best || w < best.w) best = { w, id: i.id, x: i.x, y: i.y }; }); return best || { w: 99, id: null, x: null, y: null }; }
    };
  }
  const snapOrder = o => o.map(s => ({ ex: s.ex.slice(), orig: s.orig ? s.orig.slice() : undefined }));
  function refreshUnits(order, c) { order.forEach(s => { const w = c.wait(s.ex[1]); if (w.id) s.id = w.id; s.wait = w.w; }); }
  function describe(res, c) {
    const it = res.unit && res.unit.id ? res.unit.id : null, to = res.to ? res.to[0] : '', name = it ? unitName(it) : '';
    return { type: res.type, from: res.from ? res.from[0] : '', to, unit: name || to, waitBefore: Math.round(res.waitBefore || 0), waitAfter: Math.round(res.waitAfter || 0), distM: Math.round(res.distM || 0), why: res.why || res.text || '', at: Date.now() };
  }
  // оценка маршрута: вызывается на старте, при смене шага и по тикам
  function routeEval(reason) {
    const W = B.state.wo, Pl = B.state.plan; if (!W || !Pl || !Pl.order) return;
    const now = Date.now(); if (reason === 'tick' && now - route.lastAt < 4000) return; route.lastAt = now;
    const c = ctx(), started = W.set > 0 || W.rest, idx = started ? W.i + 1 : W.i;
    if (idx >= Pl.order.length || now < route.hold) return;
    // 1. вернуть освободившееся упражнение
    const back = R.checkReturn(Pl.order, idx, c);
    if (back) { route.undo = snapOrder(Pl.order); R.applyReturn(Pl.order, back); refreshUnits(Pl.order, c); route.last = describe(back, c); route.last.waitBefore = 0; B.notify('Маршрут: ' + route.last.to + ' освободился', 'Вернули упражнение в программу · ' + route.last.distM + ' м', () => { }); B.buzz([10, 40, 10]); return; }
    // 2. занято надолго? переставить или заменить; для следующего упражнения порог выше
    c.threshold = started ? 6 : 3;
    const cur = Pl.order[idx]; if (!cur) return;
    const res = R.evaluate(Pl.order, idx, c); if (!res || res.type === 'wait') { if (res && res.type === 'wait' && !route.waitNote) { route.waitNote = true; } return; }
    route.undo = snapOrder(Pl.order); R.apply(Pl.order, res); refreshUnits(Pl.order, c);
    const d = describe(res, c); d.step = idx; route.last = d; route.hold = now + 8000;
    B.notify('ROUTE UPDATED', (res.type === 'reorder' ? res.to[0] + ' — сейчас' : d.to + ' вместо «' + d.from + '»') + ' · свободно сейчас · ' + d.distM + ' м', () => { }); B.buzz([12, 50, 12]);
    AI.bus.emit('route', d);
  }
  B.freeAtAI = type => { const w = (function () { const c = ctx(); return c.wait(type); })(); return w && w.id && w.w < 99 ? { w: w.w, id: w.id } : null; };
  UI.routeEval = routeEval; route.ctxFor = ctx; route.describe = describe;
  B.hooks.woStart.push(() => { route.pos = { x: 180, y: 479 }; route.last = null; route.undo = null; route.hold = 0; route.lastAt = 0; routeEval('start'); });
  B.hooks.woEnd.push(() => { route.last = null; route.undo = null; });
  B.hooks.woStep.push(() => {
    const W = B.state.wo, Pl = B.state.plan; if (!W || !Pl) return;
    const prev = Pl.order[W.i - 1]; if (prev && prev.id) { const it = UI.snapNow().eq.items.find(i => i.id === prev.id); if (it) route.pos = { x: it.x, y: it.y }; }
    route.last = route.last && Date.now() - route.last.at < 1500 ? route.last : null; routeEval('step');
  });
  B.hooks.tick.push(() => { if (B.state.wo) routeEval('tick'); });

  function routeCard(d) {
    const T = { reorder: 'Порядок изменён', sub: 'Упражнение заменено', return: 'Упражнение вернулось' }[d.type] || 'Маршрут обновлён';
    const l1 = d.type === 'return' ? `«${esc(d.to)}» снова свободен` : `«${esc(d.from)}» занят · ожидание ~${d.waitBefore} мин`;
    const l2 = d.type === 'reorder' ? `Сначала «${esc(d.to)}» — свободно сейчас · ${d.distM} м` : d.type === 'return' ? `Возвращаем в программу · ${d.distM} м` : `→ ${esc(d.unit)} · свободно сейчас · ${d.distM} м`;
    return `<div class="rt-card"><div class="rt-top"><span class="ai-label">ROUTE UPDATED</span><span class="rt-t">${T}</span></div><p class="rt-l1">${l1}</p><p class="rt-l2"><svg class="ico"><use href="#i-route"/></svg>${l2}</p><small>${esc(d.why)}</small><button type="button" class="rt-undo" data-routeundo>Вернуть как было</button></div>`;
  }
  UI.routeCard = routeCard;
  B.woExtra = (W, Pl) => {
    let h = '';
    if (Pl && Pl.welcome) h += `<div class="rt-wb"><span class="ai-label">WELCOME BACK</span><b>Мягкий старт</b><small>${esc(Pl.welcome.text)} · ${Pl.welcome.exercises} упражнений · ~${Pl.welcome.minutes} мин</small></div>`;
    if (route.last) h += routeCard(route.last);
    return h;
  };
  const woEl = $('[data-wo]');
  woEl.addEventListener('click', e => {
    if (!e.target.closest('[data-routeundo]')) return;
    const Pl = B.state.plan; if (!route.undo || !Pl) return;
    Pl.order.forEach((s, k) => { if (route.undo[k]) { s.ex = route.undo[k].ex; if (route.undo[k].orig) s.orig = route.undo[k].orig; else delete s.orig; } });
    refreshUnits(Pl.order, ctx()); route.last = null; route.undo = null; route.hold = Date.now() + 60000; B.renderWO(); B.buzz(8); B.toast('Маршрут возвращён');
  });
})();
