/* =====================================================================
   DDX Vision — интерфейс AI-слоя, часть 3: Vision Coach и Body Twin (с блоком возвращения).
   ===================================================================== */
(function () {
  'use strict';
  const B = window.DDX, AI = window.DDXAI, UI = AI && AI.ui;
  if (!B || !AI || !UI) return;
  const { $, $$, hm, plural, clamp } = B, esc = AI.util.esc, EX = AI.COACH_EX, P = AI.privacy;
  const IC = n => `<svg class="ico"><use href="#${n}"/></svg>`;

  /* ============================================================ VISION COACH */
  const host = $('[data-coach]');
  const co = UI.coach = { phase: 'intro', ex: 'squat', idm: 'nfc', consent: false, sess: null, prov: null, paused: false, lastT: 0, sum: null, flash: 0, repShown: -1, speed: 1, sid: 'A7F3', scenario: false };
  const ZONE_OF = { squat: 'Зона приседаний · CAM 05', lunge: 'Зона приседаний · CAM 05', press: 'Зона гантелей · CAM 07', curl: 'Зона гантелей · CAM 07', lateral: 'Зона гантелей · CAM 07' };
  const IDM = { nfc: 'Браслет DDX / NFC', qr: 'QR-код', ble: 'BLE-метка' };
  const tone = { GOOD: 'ok', FAIR: 'mid', SHALLOW: 'bad', FAST: 'bad', SLOW: 'mid', NORMAL: 'ok', WATCH: 'mid', UNEVEN: 'bad' };
  let cv = null;

  const head = `<div class="ai-head rv"><div><h2 class="h-title">VISION COACH</h2><p class="h-sub">Подсказки по технике · не медицинская оценка</p></div>${UI.modeBadge()}</div>${UI.navHtml('coach')}`;
  function introHtml() {
    const exs = AI.COACH_EXLIST.map(id => `<button type="button" class="chip${co.ex === id ? ' is-on' : ''}" data-coex="${id}">${EX[id].en}</button>`).join('');
    const ids = Object.keys(IDM).map(k => `<button type="button" class="chip${co.idm === k ? ' is-on' : ''}" data-coid="${k}">${IDM[k]}</button>`).join('');
    return `${head}
      <div class="card co-card rv"><h3 class="ai-h3" style="margin-top:0">Как это работает</h3><ol class="co-steps"><li>Подойдите в Vision-зону: она отмечена на полу и на карте.</li><li>Подключите временную сессию браслетом, NFC, QR или BLE. Камера связывает силуэт в зоне с сессией, <b>лицо не распознаётся</b>.</li><li>Выполняйте упражнение: повторы, диапазон, темп, симметрия и одна короткая подсказка. После подхода связь закрывается.</li></ol></div>
      <div class="co-sec rv"><small class="ai-cap">Что покажет демо-симулятор</small><div class="chips">${exs}</div><p class="ai-foot" style="margin:6px 0 0">${ZONE_OF[co.ex]} · упражнение система распознаёт сама по движению.</p></div>
      <div class="co-sec rv"><small class="ai-cap">Как подключить сессию</small><div class="chips">${ids}</div></div>
      <label class="co-consent rv"><input type="checkbox" data-coconsent ${P.consent.coach || co.consent ? 'checked' : ''}><span>Согласен(на) на анализ движений в этой зоне на время подхода. Видео не сохраняется, хранятся только метрики; согласие можно отозвать в «Данных и согласиях».</span></label>
      <div class="rv"><button class="btn btn--o btn--w" type="button" data-costart>${IC('i-play').replace('class="ico"', 'class="ico" style="fill:currentColor;stroke:none"')}Подключить сессию и начать</button></div>
      <p class="ai-foot rv">Vision Coach даёт тренировочные подсказки и не ставит медицинских диагнозов и не гарантирует предотвращение травм. Проверено на небольшом наборе упражнений: приседание, выпад, жим плечами, сгибание на бицепс, разведение в стороны. DEMO: движение выполняет симулятор, в продукте ключевые точки приходят с edge-сервера клуба.</p>`;
  }
  function liveHtml() {
    return `
      <div class="co-stage rv" data-costage><canvas data-cocv></canvas>
        <div class="co-hud-t"><span class="co-pill">${AI.orch.mode === 'LIVE' ? '' : 'DEMO · '}SESSION ${co.sid} · TEMP</span><span class="co-pill edge">EDGE · 0 Б ВИДЕО</span></div>
        <div class="co-ex"><b data-co="ex">SCANNING…</b><small data-co="conf">определяем упражнение</small></div>
        <div class="co-prog"><i data-co="prog"></i></div></div>
      <div class="co-metrics rv">
        <div class="co-m rep"><small>REP</small><b class="num" data-co="rep">0 <em>/ 10</em></b></div>
        <div class="co-m"><small>RANGE OF MOTION</small><b data-co="range">—</b><span data-co="rangeS"></span></div>
        <div class="co-m"><small>TEMPO</small><b data-co="tempo">—</b><span data-co="tempoS"></span></div>
        <div class="co-m"><small>SYMMETRY</small><b data-co="sym">—</b><span data-co="symS"></span></div></div>
      <div class="co-cue rv" data-co="cue"><span class="ai-label dark">COACH</span><p>Начните движение — подскажу после первого повтора.</p></div>
      <div class="co-btns rv"><button class="btn btn--g" type="button" data-copause>Пауза</button><button class="btn btn--g" type="button" data-coreset>Заново</button><button class="btn btn--o" type="button" data-coend>Завершить</button></div>
      <p class="ai-foot rv">${ZONE_OF[co.ex]} · ${IDM[co.idm]}</p>`;
  }
  function sumHtml() {
    const s = co.sum, e = EX[s.exercise || co.ex], n = Math.max(1, s.reps);
    const issues = []; if (s.fast) issues.push('темп местами слишком быстрый (' + s.fast + ' ' + plural(s.fast, ['повтор', 'повтора', 'повторов']) + ')'); if (s.reps - s.normalSym) issues.push('заметна разница между сторонами (' + (s.reps - s.normalSym) + ' ' + plural(s.reps - s.normalSym, ['повтор', 'повтора', 'повторов']) + ')'); if (s.reps - s.goodRange) issues.push('не везде полная амплитуда (' + (s.reps - s.goodRange) + ' ' + plural(s.reps - s.goodRange, ['повтор', 'повтора', 'повторов']) + ')'); if (s.partials) issues.push('неполных повторов не засчитано: ' + s.partials);
    const take = issues.length ? 'Над чем поработать: ' + issues.join('; ') + '.' : 'Все повторы выполнены в хорошем диапазоне, темп ровный.';
    return `${head}
      <div class="ai-hero rv"><div class="ai-hero-top"><span class="ai-label">SET COMPLETE</span><span class="ai-upd">сессия закрыта</span></div><h3 class="co-sum-h">${e.en}</h3>
        <div class="ai-stats"><div><small>REPS</small><b class="num">${s.reps}</b></div><div><small>AVG TEMPO</small><b class="num">${s.avgTempo.toFixed(1).replace('.', ',')}<em> с</em></b></div></div>
        <div class="co-sum-g"><span>Хороший диапазон <b>${s.goodRange}/${s.reps}</b></span><span>Симметрия в норме <b>${s.normalSym}/${s.reps}</b></span></div><p class="ai-sum">${take}</p></div>
      <div class="ai-note rv">${IC('i-shield')}<span>Связь сессии ${co.sid} закрыта. Видео не сохранялось (0 Б). Сохранены только числовые метрики подхода; срок хранения — ${P.retention.sessionDays} дн., удалить можно в «Данных и согласиях».</span></div>
      <div class="co-btns rv" style="grid-template-columns:1fr 1fr"><button class="btn btn--g" type="button" data-coagain>Ещё подход</button><button class="btn btn--o" type="button" data-coclose>Готово</button></div>`;
  }
  function setPhase(ph) { co.phase = ph; host.innerHTML = ph === 'intro' ? introHtml() : ph === 'live' ? liveHtml() : sumHtml(); cv = $('[data-cocv]', host); co.repShown = -1; co.hudKey = ''; }
  UI.screens.coach = { render() { if (!host.firstChild) setPhase(co.phase); $$('[data-aimode]', host).forEach(b => { b.className = 'ai-badge ' + (AI.orch.mode === 'LIVE' ? 'is-live' : 'is-demo'); b.innerHTML = AI.orch.mode === 'LIVE' ? '<i></i>LIVE' : 'DEMO'; }); }, frame: coachFrame };
  UI.enter.coach = () => { if (co.phase === 'summary') co.phase = 'intro'; if (co.phase !== 'live') setPhase('intro'); else setPhase('live'); };
  B.acts.coach = () => B.go('coach');

  /* ---------- запуск ---------- */
  function startSession(opts) {
    opts = opts || {}; co.sid = opts.sid || AI.registry.identity.open(co.idm, ZONE_OF[co.ex]).id;
    const plan = opts.plan || AI.SimulatedPoseProvider.defaultPlan(co.ex, 10);
    co.prov = new AI.SimulatedPoseProvider({ exercise: co.ex, reps: plan, seed: opts.seed || Math.floor(Math.random() * 99) + 1 });
    co.sess = new AI.CoachSession({ provider: co.prov, exercise: 'auto', target: 10, sessionId: co.sid });
    co.paused = false; co.speed = opts.speed || 1; co.lastT = 0; co.sum = null; co.scenario = !!opts.scenario; co.heldAt7 = false; co.holdUntil = 0;
    P.log('session.open', 'временная сессия ' + co.sid + ' · ' + IDM[co.idm] + ' · ' + ZONE_OF[co.ex].split(' · ')[0]);
    setPhase('live');
    if (opts.ffTo != null) { const target = co.prov.reps[opts.ffTo].t0 - 0.4; while (co.prov.t < target) co.sess.step(1 / 30); }
  }
  UI.coachStart = startSession;
  function finish(manual) {
    if (!co.sess) return; co.sum = co.sess.end(); co.sum.exercise = co.sess.exercise || co.ex;
    P.log('session.close', 'сессия ' + co.sid + ' закрыта · повторов ' + co.sum.reps + ' · видео 0 Б'); P.log('coach.metrics', 'сохранены метрики без видео (' + co.sum.reps + ' повт.)');
    AI.registry.identity.close(co.sid); co.sess = null; setPhase('summary'); B.buzz([10, 40, 10]); if (!manual) B.confetti(50);
  }
  UI.coachFinish = finish;
  host.addEventListener('click', e => {
    const t = e.target, q = sel => t.closest(sel);
    let x;
    if ((x = q('[data-aimode]'))) { UI.openMode(); return; }
    if ((x = q('[data-coex]'))) { co.ex = x.dataset.coex; B.buzz(5); setPhase('intro'); return; }
    if ((x = q('[data-coid]'))) { co.idm = x.dataset.coid; B.buzz(5); setPhase('intro'); return; }
    if (q('[data-costart]')) {
      const ck = $('[data-coconsent]', host); if (!(ck && ck.checked)) { B.toast('Нужно согласие на анализ движений'); B.buzz(10); return; }
      if (!P.consent.coach) { P.consent.coach = true; P.log('consent.coach', 'дано'); UI.persist(); }
      startSession(); return;
    }
    if (q('[data-copause]')) { co.paused = !co.paused; q('[data-copause]').textContent = co.paused ? 'Продолжить' : 'Пауза'; B.buzz(5); return; }
    if (q('[data-coreset]')) { startSession({ sid: co.sid }); return; }
    if (q('[data-coend]')) { finish(true); return; }
    if (q('[data-coagain]')) { setPhase('intro'); return; }
    if (q('[data-coclose]')) { setPhase('intro'); B.go('live'); return; }
  });

  /* ---------- кадр: шаг сессии + рисование скелета ---------- */
  function coachFrame(t) {
    if (co.phase !== 'live' || !co.sess || !cv) return;
    const dt = co.lastT ? clamp((t - co.lastT) / 1000, 0, 0.1) : 0; co.lastT = t;
    let view = co.sess.view(); if (!co.paused && !(co.holdUntil && t < co.holdUntil)) view = co.sess.step(dt * co.speed);
    // в демо-сценарии задерживаем кадр на 7-м повторе, чтобы подсказка успела прочитаться
    if (co.scenario && view.reps === 7 && !co.heldAt7) { co.heldAt7 = true; co.holdUntil = t + 3200; }
    draw(view, t); hud(view);
    if (view.done && !co.paused && !co.holdFinish) setTimeout(() => { if (co.phase === 'live') finish(false); }, 1200), co.holdFinish = true;
    if (!view.done) co.holdFinish = false;
  }
  function draw(v, t) {
    const r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2), W = r.width, H = r.height; if (!W) return;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#0a2a2f'); bg.addColorStop(1, '#02161a'); g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(104,218,224,.10)'; g.lineWidth = 1; const vy = H * 0.36;
    for (let k = -7; k <= 7; k++) { g.beginPath(); g.moveTo(W / 2 + k * W * 0.035, vy); g.lineTo(W / 2 + k * W * 0.26, H); g.stroke(); }
    for (let k = 1; k < 8; k++) { const yy = vy + (H - vy) * Math.pow(k / 8, 1.7); g.beginPath(); g.moveTo(0, yy); g.lineTo(W, yy); g.stroke(); }
    const f = v.frame; if (!f) return;
    const s = H * 0.72 / 1.8, ox = W * 0.5, oy = H * 0.9, Pn = f.kp2.map(p => [ox + p[0] * s, oy - p[1] * s]);
    // рамка силуэта
    const xs = Pn.map(p => p[0]), ys = Pn.map(p => p[1]), x0 = Math.min(...xs) - 16, x1 = Math.max(...xs) + 16, y0 = Math.min(...ys) - 18, y1 = Math.max(...ys) + 10;
    g.strokeStyle = 'rgba(39,246,248,.55)'; g.lineWidth = 1.2; g.setLineDash([6, 4]); g.strokeRect(x0, y0, x1 - x0, y1 - y0); g.setLineDash([]);
    g.fillStyle = '#03D1D6'; g.fillRect(x0, y0 - 14, 112, 14); g.fillStyle = '#012E36'; g.font = '700 9px Onest, sans-serif'; g.fillText('person · session ' + co.sid, x0 + 4, y0 - 4);
    // кости
    g.save(); g.lineCap = 'round'; g.shadowColor = '#27F6F8'; g.shadowBlur = 10; g.strokeStyle = '#27F6F8'; g.lineWidth = 3.2;
    AI.BONES.forEach(([a, b]) => { g.beginPath(); g.moveTo(Pn[a][0], Pn[a][1]); g.lineTo(Pn[b][0], Pn[b][1]); g.stroke(); }); g.restore();
    { const hx = (Pn[3][0] + Pn[4][0]) / 2, hy = (Pn[3][1] + Pn[4][1]) / 2, mx = (Pn[5][0] + Pn[6][0]) / 2, my = (Pn[5][1] + Pn[6][1]) / 2, hr = Math.hypot(Pn[3][0] - Pn[4][0], Pn[3][1] - Pn[4][1]) * 0.55 + 4;
      g.save(); g.shadowColor = '#27F6F8'; g.shadowBlur = 8; g.strokeStyle = '#27F6F8'; g.lineWidth = 3; g.lineCap = 'round'; g.beginPath(); g.moveTo(mx, my); g.lineTo(hx, hy + hr * 0.8); g.stroke(); g.beginPath(); g.arc(hx, hy, hr, 0, 7); g.stroke(); g.restore(); }
    const key = { squat: [13, 14], lunge: [13, 14], press: [7, 8], curl: [7, 8], lateral: [5, 6] }[v.exercise] || [];
    Pn.forEach((p, i) => { const hot = key.indexOf(i) >= 0; g.beginPath(); g.arc(p[0], p[1], hot ? 6.5 : 3.6, 0, 7); g.fillStyle = hot ? '#FD7505' : '#fff'; g.fill(); if (hot) { g.strokeStyle = 'rgba(253,117,5,.45)'; g.lineWidth = 3; g.stroke(); } });
    if (v.exercise && co.sess) { const sg = AI.coachSignal(v.exercise, f.kp3), jp = Pn[key[1]] || Pn[0]; g.font = '700 13px Oswald, sans-serif'; g.fillStyle = '#FFA75F'; g.fillText(Math.round(sg.v) + '°', jp[0] + 12, jp[1] - 8); }
    // сканирующая линия
    const sy = (t / 14) % (H + 60) - 30, sg2 = g.createLinearGradient(0, sy - 26, 0, sy + 26); sg2.addColorStop(0, 'rgba(18,216,216,0)'); sg2.addColorStop(0.5, v.recognizing ? 'rgba(18,216,216,.28)' : 'rgba(18,216,216,.10)'); sg2.addColorStop(1, 'rgba(18,216,216,0)'); g.fillStyle = sg2; g.fillRect(0, sy - 26, W, 52);
    if (co.paused) { g.fillStyle = 'rgba(0,13,15,.55)'; g.fillRect(0, 0, W, H); g.fillStyle = '#fff'; g.font = '700 22px Oswald, sans-serif'; g.textAlign = 'center'; g.fillText('ПАУЗА', W / 2, H / 2); g.textAlign = 'start'; }
  }
  const put = (k, html) => { const el = $(`[data-co="${k}"]`, host); if (el && el._v !== html) { el._v = html; el.innerHTML = html; } };
  function hud(v) {
    const e = v.exercise ? EX[v.exercise] : null, L = v.last;
    put('ex', e ? e.en : 'SCANNING…'); put('conf', e ? (v.auto ? 'распознано автоматически · ' + Math.round(v.conf * 100) + '%' : 'выбрано вручную') : 'определяем упражнение по движению');
    put('rep', v.reps + ' <em>/ ' + v.target + '</em>');
    put('range', L ? `<span class="tg ${tone[L.range]}">${L.range}</span>` : '—'); put('rangeS', L ? Math.round(L.rom) + '° · цель ' + e.sEffort + '°' : '');
    put('tempo', L ? `<span class="tg ${tone[L.tempo]}">${L.ecc.toFixed(1).replace('.', ',')} sec</span>` : '—'); put('tempoS', L ? L.tempo : '');
    put('sym', L ? `<span class="tg ${tone[L.symmetry]}">${L.symmetry}</span>` : '—'); put('symS', L ? (L.lagging ? 'отстаёт ' + (L.lagging === 'L' ? 'левая' : 'правая') : 'Δ ' + L.diff.toFixed(0) + '°') : '');
    const cue = v.cue && v.cueAge < 7 ? v.cue : null;
    put('cue', `<span class="ai-label dark">COACH</span><p class="${cue ? 'tn-' + cue.tone : ''}">${cue ? esc(cue.text) : v.recognizing ? 'Начните движение — определяю упражнение…' : 'Продолжайте в том же темпе.'}</p>`);
    const pr = $('[data-co="prog"]', host); if (pr && co.sess && co.sess.counter) { const u = co.sess.counter.ema == null ? 0 : co.sess.counter.u(co.sess.counter.ema); pr.style.height = clamp(u, 0, 1.1) / 1.1 * 100 + '%'; }
    if (v.reps !== co.repShown) { if (co.repShown >= 0 && v.reps > co.repShown) { const st = $('[data-costage]', host); if (st) { st.classList.remove('flash'); void st.offsetWidth; st.classList.add('flash'); } B.buzz(8); } co.repShown = v.reps; }
  }

  /* ============================================================ BODY TWIN */
  const th = $('[data-twin]');
  const bt = UI.bt = { profile: UI.prefs.profile || 'pro', exKey: null, lines: null };
  const nf = (v, d) => String(Math.round(v * Math.pow(10, d || 0)) / Math.pow(10, d || 0)).replace('.', ',');
  const REASON = { consent: 'нет согласия на источник', few: 'мало данных', none: 'нет замеров' };
  const HINT = { strength: 'нужно ≥ 3 подходов в упражнении за 4 недели', consistency: 'нужно ≥ 6 запланированных тренировок', volume: 'нужно ≥ 4 тренировки за месяц', body: 'подключите замер InBody' };
  const insuff = (k, o) => `<div class="bt-t is-no"><small>${{ strength: 'STRENGTH', consistency: 'CONSISTENCY', volume: 'TRAINING VOLUME', body: 'BODY COMPOSITION' }[k]}</small><b class="bt-no">INSUFFICIENT DATA</b><span>${o.reason === 'few' || o.reason === 'none' ? HINT[k] : REASON[o.reason]}</span></div>`;
  function spark(m) {
    const w = {}; m.sessions.forEach(s => { if (!s.done || s.day < -83) return; const k = Math.floor((s.day + 84) / 7); s.lifts.forEach(l => { (w[k] = w[k] || []).push(l.kg * (1 + l.reps / 30)); }); });
    const keys = Object.keys(w).map(Number).sort((a, b) => a - b); if (keys.length < 4) return '';
    const vals = keys.map(k => w[k].reduce((a, b) => a + b, 0) / w[k].length), mn = Math.min(...vals), mx = Math.max(...vals), rng = Math.max(1, mx - mn);
    const pts = keys.map((k, i) => `${(k / 11 * 100).toFixed(1)},${(26 - (vals[i] - mn) / rng * 22).toFixed(1)}`).join(' ');
    return `<svg class="bt-sp" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>`;
  }
  function btRender() {
    const m = AI.loadMember(bt.profile), S = P.consent.sources, t = AI.bodyTwin(m, { inbody: S.inbody, workouts: S.workouts }), ret = AI.Return.ofMember(m);
    const profs = AI.Members.PROFILES.map(p => `<button type="button" class="chip${bt.profile === p.id ? ' is-on' : ''}" data-btp="${p.id}">${p.ru}</button>`).join('');
    const st = t.strength, cs = t.consistency, vo = t.volume, bo = t.body, go = t.goal;
    const tiles = [
      st.state === 'ok' ? `<div class="bt-t"><small>STRENGTH</small><b class="num">${st.pct >= 0 ? '+' : ''}${Math.round(st.pct * 100)}%</b><span>за ${st.windowWeeks} недель</span>${spark(m)}</div>` : insuff('strength', st),
      cs.state === 'ok' ? `<div class="bt-t"><small>CONSISTENCY</small><b class="num">${Math.round(cs.pct * 100)}%</b><span>${cs.done} из ${cs.planned} тренировок${cs.prevPct != null ? ' · прошлый месяц ' + Math.round(cs.prevPct * 100) + '%' : ''}</span></div>` : insuff('consistency', cs),
      vo.state === 'ok' ? `<div class="bt-t"><small>TRAINING VOLUME</small><b class="num">${vo.pct >= 0 ? '+' : ''}${Math.round(vo.pct * 100)}%</b><span>к прошлому месяцу</span></div>` : insuff('volume', vo),
      bo.state === 'ok' ? `<div class="bt-t"><small>BODY COMPOSITION</small><b class="num">${nf(bo.smm, 1)}<em> кг</em></b><span>мышцы · жир ${nf(bo.fat, 1)}% · замер ${bo.ageDays} ${plural(bo.ageDays, ['день', 'дня', 'дней'])} назад${bo.stale ? ' (устарел)' : ''}</span></div>` : insuff('body', bo)
    ].join('');
    const statusCls = { 'ON TRACK': 'ok', AHEAD: 'ok', BEHIND: 'mid', 'OFF TRACK': 'bad', 'INSUFFICIENT DATA': 'no' }[go.status];
    const goalCard = go.state === 'ok'
      ? `<div class="card bt-goal"><div class="bt-gh"><small class="ai-cap">GOAL PROGRESS · ${esc(go.ru)}</small><span class="tg ${statusCls}">${go.status}</span></div><div class="bt-bar"><i style="width:${Math.round(Math.min(1, go.progress) * 100)}%"></i><b class="num">${Math.round(Math.min(1, go.progress) * 100)}%</b></div><div class="bt-gs"><span>${nf(go.baseline, 1)} кг</span><span>сейчас ${nf(go.current, 1)}</span><span>цель ${nf(go.target, 1)} кг</span></div><p class="ai-foot" style="margin:8px 0 0">Оценка траектории — по линейному тренду ${go.points} замеров; осталось ${go.daysLeft} ${plural(go.daysLeft, ['день', 'дня', 'дней'])}. Это ориентир, не обещание результата.</p></div>`
      : `<div class="card bt-goal"><div class="bt-gh"><small class="ai-cap">GOAL PROGRESS · ${esc(m.goal.ru)}</small><span class="tg no">INSUFFICIENT DATA</span></div><p class="ai-foot" style="margin:8px 0 0">${go.reason === 'consent' ? 'Источник InBody отключён в «Данных и согласиях» — прогноз не строится.' : 'Нужно не менее 3 замеров за 3 недели, чтобы оценить траекторию. Выдуманный прогноз мы не показываем.'}</p></div>`;
    const wb = ret.signal !== 'NORMAL' ? (() => { const w = AI.Return.welcome(ret.daysSince); return `<div class="card bt-wb"><div class="bt-gh"><small class="ai-cap dark">WELCOME BACK</small><span class="tg ${ret.signal === 'DECLINING' ? 'bad' : 'mid'}">${ret.signal === 'DECLINING' ? 'DECLINING ENGAGEMENT' : 'WATCH'}</span></div><b class="bt-wbh">Рады видеть вас снова</b><p>Последняя тренировка: <b>${ret.daysSince} ${plural(ret.daysSince, ['день', 'дня', 'дней'])} назад</b>. Сегодня мягкий старт:</p><div class="bt-wbg"><span><b>${w.minutes}</b> мин</span><span><b>−${w.loadCutPct}%</b> стартовая нагрузка</span><span><b>${w.exercises}</b> упражнений</span></div><button class="btn btn--o btn--w" type="button" data-btwb>Начать мягкую тренировку</button></div>`; })() : '';
    const lim = ['knee', 'back', 'shoulder'].map(k => `<button type="button" class="chip${(UI.prefs.limits || []).indexOf(k) >= 0 ? ' is-on' : ''}" data-btlim="${k}">${AI.Routing.LIMITS[k]}</button>`).join('');
    B.setH($('[data-bt="body"]', th), `<div class="bt-tiles">${tiles}</div>${goalCard}${wb}`);
    B.setH($('[data-bt="profs"]', th), profs); B.setH($('[data-bt="lim"]', th), lim);
    $('[data-bt="id"]', th).textContent = m.id + ' · демо-профиль «' + AI.Members.PROFILES.find(p => p.id === bt.profile).ru + '»';
    $$('[data-aimode]', th).forEach(b => { b.className = 'ai-badge ' + (AI.orch.mode === 'LIVE' ? 'is-live' : 'is-demo'); b.innerHTML = AI.orch.mode === 'LIVE' ? '<i></i>LIVE' : 'DEMO'; });
    // объяснения: числа только из фактов, текст проходит проверку
    const key = bt.profile + JSON.stringify(S);
    if (bt.exKey !== key) {
      bt.exKey = key; bt.lines = null; const facts = AI.Progress.facts(t);
      if (!facts.length) bt.lines = { lines: [], by: 'none' };
      else AI.Progress.safeExplain(new AI.Progress.TemplateExplainer(), facts).then(r => { if (bt.exKey === key) { bt.lines = r; btLines(); } });
    }
    btLines();
  }
  function btLines() {
    const el = $('[data-bt="lines"]', th); if (!el) return;
    if (!bt.lines) { B.setH(el, '<div class="empty">Считаем…</div>'); return; }
    B.setH(el, bt.lines.lines.length ? `<div class="card bt-ai"><ul>${bt.lines.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul><p class="ai-foot" style="margin:8px 0 0">Числа посчитаны детерминированной аналитикой; текст только пересказывает их (${bt.lines.by === 'TemplateExplainer' ? 'шаблонный пояснитель' : bt.lines.by}). Подключить языковую модель можно через ExplainerProvider — с проверкой, что в тексте нет чисел вне фактов.</p></div>` : '<div class="empty">Пока не о чем рассказывать: данных недостаточно.</div>');
  }
  function btBuild() {
    th.innerHTML = `<div class="ai-head rv"><div><h2 class="h-title">BODY TWIN</h2><p class="h-sub" data-bt="id"></p></div>${UI.modeBadge()}</div>${UI.navHtml('twin')}
      <div class="co-sec rv"><small class="ai-cap">Демо-профиль участника</small><div class="chips" data-bt="profs"></div></div>
      <div data-bt="body" class="rv"></div>
      <h3 class="ai-h3 rv">AI PROGRESS</h3><div data-bt="lines" class="rv"></div>
      <h3 class="ai-h3 rv">Для маршрута тренировки</h3><div class="co-sec rv"><small class="ai-cap">Учитывать ограничения</small><div class="chips" data-bt="lim"></div><p class="ai-foot" style="margin:6px 0 0">Маршрут не будет подставлять упражнения с нагрузкой на отмеченные зоны.</p></div>
      <div class="rv" style="margin-top:12px"><button class="btn btn--g btn--w" type="button" data-act="privacyai">${IC('i-shield')}Источники данных и согласия</button></div>
      <p class="ai-foot rv">DEMO · история тренировок и замеры — синтетические. BODY TWIN не ставит диагнозов; при нехватке данных вместо прогноза показываем INSUFFICIENT DATA.</p>`;
  }
  UI.screens.twin = { render() { if (!th.firstChild) btBuild(); btRender(); } };
  UI.enter.twin = () => { if (!th.firstChild) btBuild(); btRender(); };
  UI.onConsent = () => { bt.exKey = null; if (B.state.screen === 'twin') btRender(); if (co.phase === 'intro' && B.state.screen === 'coach') setPhase('intro'); };
  B.acts.twin = () => B.go('twin');
  th.addEventListener('click', e => {
    const t = e.target; let x;
    if ((x = t.closest('[data-aimode]'))) { UI.openMode(); return; }
    if ((x = t.closest('[data-btp]'))) { bt.profile = x.dataset.btp; UI.prefs.profile = bt.profile; UI.persist(); bt.exKey = null; B.buzz(5); btRender(); return; }
    if ((x = t.closest('[data-btlim]'))) { const k = x.dataset.btlim, a = UI.prefs.limits || (UI.prefs.limits = []); const i = a.indexOf(k); if (i >= 0) a.splice(i, 1); else a.push(k); UI.persist(); B.buzz(5); btRender(); return; }
    if (t.closest('[data-btwb]')) { startWelcome(); }
  });
  // «Welcome back»: короткая тренировка из привычной цели с пониженной нагрузкой
  function startWelcome() {
    const m = AI.Members.make(bt.profile), r = AI.Return.ofMember(m), goalId = B.state.goal, G = B.GOALS[goalId], wp = AI.welcomePlan(G.ex, r.daysSince);
    const order = []; let tt = 0, wait = 0; wp.ex.forEach(ex => { const f = B.freeAt(ex[1]), w = Math.max(0, f.w - tt); order.push({ ex, id: f.id, wait: w, at: tt + w }); wait += w; tt += w + B.exMins(ex); });
    B.state.plan = { goal: goalId, dur: 45, order, total: tt, wait, naive: wait + 4, changed: false, welcome: wp.info };
    P.log('welcome.start', 'мягкий старт: −' + wp.info.loadCutPct + '% нагрузки, ' + wp.info.exercises + ' упражнений');
    B.startWorkout();
  }
  UI.startWelcome = startWelcome;
})();
