/* =====================================================================
   DDX Vision — демо-сценарий для презентации руководству.
   Сценарий не подменяет движки: он подаёт им заранее заданные данные через тот же
   CameraProvider / EquipmentProvider (режим DEMO), поэтому все экраны и расчёты живые.
   Запуск: кнопка «Демо-сценарий» или адрес с #demo.
   ===================================================================== */
(function () {
  'use strict';
  const B = window.DDX, AI = window.DDXAI, UI = AI && AI.ui;
  if (!B || !AI || !UI) return;
  const { $, $$, hm } = B, orch = AI.orch, P = AI.privacy, esc = AI.util.esc;

  /* ---------- данные сценария ---------- */
  const Z = (free, legs, chest, back, cardio, func, stretch, group, locker, entrance) => ({ free, legs, chest, back, cardio, func, stretch, group, locker, entrance });
  const TARGET = {
    A: { people: 284, z: Z(0.94, 0.73, 0.66, 0.58, 0.41, 0.56, 0.33, 0.70, 0.48, 0.30), f15: Z(0.953, 0.78, 0.80, 0.60, 0.42, 0.58, 0.34, 0.70, 0.50, 0.32), f30: Z(0.97, 0.82, 0.88, 0.64, 0.43, 0.60, 0.35, 0.42, 0.52, 0.34) },
    C: { people: 291, z: Z(0.97, 0.80, 0.96, 0.58, 0.43, 0.54, 0.34, 0.70, 0.50, 0.34), f15: Z(0.98, 0.84, 0.97, 0.60, 0.44, 0.56, 0.35, 0.70, 0.52, 0.35), f30: Z(0.99, 0.88, 0.98, 0.64, 0.45, 0.58, 0.36, 0.45, 0.54, 0.36) }
  };
  const DWELL = { free: 18, legs: 12, chest: 9 };
  class Scenario {
    constructor() { this.active = false; this.phase = 'A'; this.clubCap = 364; this.cur = {}; this.curP = null; this.aiEvents = 5; this.eqOverlay = this.overlay(); }
    overlay() {
      const o = {}; const set = (ids, v) => ids.forEach(i => { o[i] = v; });
      set(['chest1'], { status: 'QUEUE', eta: 7, queue: 1 }); set(['shoulder1'], { status: 'QUEUE', eta: 6, queue: 1 }); set(['smith1'], { status: 'QUEUE', eta: 7, queue: 2 });
      set(['legpress2'], { status: 'AVAILABLE' }); set(['cross1'], { status: 'AVAILABLE' }); set(['cross2'], { status: 'IN_USE', eta: 4 }); set(['fly1'], { status: 'IN_USE', eta: 5 });
      set(['bench1', 'bench2', 'bench3'], { status: 'IN_USE', eta: 6 }); set(['adj1', 'adj2', 'adj4'], { status: 'IN_USE', eta: 5 });
      return o;
    }
    T() { return TARGET[this.phase]; }
    start() { this.active = true; this.phase = 'A'; this.cur = Object.assign({}, TARGET.A.z); this.curP = TARGET.A.people; }
    stop() { this.active = false; }
    setPhase(p) { this.phase = p; }
    zoneP(id) { const t = this.T().z[id], c = this.cur[id] == null ? t : this.cur[id]; return (this.cur[id] = c + (t - c) * 0.4); }
    people() { const t = this.T().people; this.curP = this.curP + (t - this.curP) * 0.4; return Math.round(this.curP); }
    dwell(id) { return DWELL[id] == null ? null : DWELL[id]; }
    forecast(id, p) { const T = this.T(), d = p - T.z[id]; return [Math.min(0.99, T.f15[id] + d * 0.8), Math.min(0.99, T.f30[id] + d * 0.6)]; }
    peak() { return { min: 19 * 60 + 10, load: 0.93 }; }
    injectEvents(anom, now) {
      [...anom.active.keys()].forEach(k => { if (k.indexOf('scn:') !== 0 && !/^(off|long):/.test(k)) anom.close(k); });
      const mk = (key, ev) => { anom.open(key, ev); const e = anom.active.get(key); if (e) e.dur = ev.dur; };
      mk('scn:smith', { type: 'congestion', zone: 'legs', sev: 'watch', title: 'Smith Zone: нетипично высокая загрузка', detail: 'Очередь до 7 мин, нагрузка продолжает расти.', dur: 11, startMin: now.min - 11 });
      mk('scn:free', { type: 'congestion', zone: 'free', sev: 'action', title: 'Free Weights: загрузка выше типичной для этого времени', detail: 'Сейчас около 94–97% при типичных 78%.', dur: 14, startMin: now.min - 14 });
      mk('scn:jump', { type: 'occupancy', zone: 'entrance', sev: 'info', title: 'Резкое изменение: +22 чел. за несколько минут', detail: 'Возможно, закончилась групповая тренировка.', dur: 3, startMin: now.min - 3 });
    }
    override(snap) { snap.clock = { dow: 2, min: 18 * 60 + 46 }; }
  }
  const scen = AI.scenario = new Scenario(); orch.attachScenario(scen);

  /* ---------- шаги ---------- */
  const layer = document.createElement('div'); layer.className = 'demo-layer'; layer.hidden = true;
  layer.innerHTML = `<div class="demo-full" data-demo-full hidden></div><div class="demo-scrim" data-demo-scrim hidden></div><div class="demo-panel" data-demo-panel hidden></div>
    <div class="demo-bar" data-demo-bar><div class="demo-prog" data-demo-prog></div><div class="demo-row"><div class="demo-t"><small data-demo-n></small><b data-demo-title></b></div><div class="demo-btns"><button type="button" data-dprev aria-label="Назад">‹</button><button type="button" data-dplay aria-label="Пауза">❚❚</button><button type="button" data-dnext aria-label="Дальше">›</button><button type="button" data-dx aria-label="Закрыть сценарий">×</button></div></div><p class="demo-cap" data-demo-cap></p></div>`;
  B.app.appendChild(layer);
  const full = $('[data-demo-full]', layer), panel = $('[data-demo-panel]', layer), scrim = $('[data-demo-scrim]', layer);
  const scrollTo = (screen, sel, off) => { const sc = $('[data-screen="' + screen + '"]'), el = sel && $(sel, sc); if (!sc) return; sc.scrollTo({ top: el ? Math.max(0, el.offsetTop - (off == null ? 72 : off)) : 0, behavior: B.REDUCE ? 'auto' : 'smooth' }); };
  const D = { on: false, i: 0, el: 0, paused: false, timer: 0, saved: null, fired: {} };

  const setTab = t => { UI.prefs.tab = t; };
  const routeSteps = () => [['Жим от груди', 'chest', 3], ['Жим вверх', 'shoulder', 3], ['Разведение гантелей', 'db', 3], ['Эллипс', 'ellip', 1]].map(ex => ({ ex }));
  const STEPS = [
    { t: 'DDX VISION', cap: 'The intelligence layer of the physical gym', dur: 3800, enter() { hidePanel(); full.hidden = false; full.innerHTML = '<span class="df-k">DDX VISION</span><h2>THE INTELLIGENCE<br>LAYER OF THE<br>PHYSICAL GYM</h2><small>Камеры — глаза. Данные — память. AI — мозг.</small>'; } },
    { t: 'Цифровой двойник клуба', cap: '284 человека · загрузка 78%. Живая карта зон, станций и людей без лиц.', dur: 5500, enter() { full.hidden = true; hidePanel(); setTab('map'); B.go('live'); UI.refresh(); scrollTo('live', null); } },
    { t: 'AI замечает: FREE WEIGHTS — 94%', cap: 'Зона свободных весов — главная точка скопления. Ожидание тренажёра растёт.', dur: 5500, enter() { UI.twin && UI.twin.select('free'); scrollTo('live', '[data-seg="aitab"]'); }, leave() { UI.twin && UI.twin.select(null); } },
    { t: 'Прогноз: CRITICAL LOAD IN 12 MIN', cap: 'Traffic Engine предсказывает перегрузку заранее и предлагает, куда направить поток.', dur: 6500, enter() { setTab('forecast'); UI.refresh(); scrollTo('live', '[data-seg="aitab"]'); } },
    { t: 'Динамический маршрут', cap: 'Жим от груди занят — маршрут перестраивается как в навигаторе, без бездумных замен.', dur: 7500, enter() { setTab('map'); UI.refresh(); scrollTo('live', null); showRoute(); }, leave: hidePanel },
    { t: 'Vision Coach · приседание', cap: 'Камера видит ключевые точки, а не лицо. Повторы, диапазон, темп, симметрия — и одна подсказка.', dur: 11500, enter() { hidePanel(); startCoach(); }, leave() { if (UI.coach) { UI.coach.sess = null; UI.coach.phase = 'intro'; } } },
    { t: 'Body Twin', cap: 'Цифровая модель прогресса: сила, регулярность, цель. Нет данных — честно пишем INSUFFICIENT DATA.', dur: 6500, enter() { UI.bt.profile = 'pro'; UI.bt.exKey = null; B.go('twin'); scrollTo('twin', null); } },
    { t: 'Command Center', cap: 'Управляющий за 10 секунд видит состояние клуба. AI сам перераспределяет поток.', dur: 10500, enter() { scen.setPhase('C'); P.setRole('manager'); B.go('command'); UI.refresh(); scrollTo('command', null); D.fired = {}; }, tick(ms) { if (ms > 3400 && !D.fired.auto) { D.fired.auto = 1; orch.setAuto(true); UI.refresh(); } if (ms > 7600 && !D.fired.say) { D.fired.say = 1; const s = UI.snapNow(), n = Math.max(1, Math.round(((s.traffic.effect || {}).savedMin) || 0)); UI.ccSay('Трафик автоматически перераспределён. Прогнозируемое ожидание сократилось примерно на ' + n + ' мин.', ['Traffic Engine', 'Prediction Engine']); const sc = $('[data-screen="command"]'); const log = $('[data-cc-log]'); log && sc && log.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }, leave() { orch.setAuto(false); } },
    { t: 'DDX VISION', cap: '', dur: 0, enter() { hidePanel(); full.hidden = false; full.innerHTML = '<span class="df-k">DDX VISION</span><h2 class="df-fin"><span>THE CLUB THAT SEES.</span><span>UNDERSTANDS.</span><span>ADAPTS.</span></h2><div class="df-btns"><button class="btn btn--o" type="button" data-dreplay>Ещё раз</button><button class="btn btn--g" type="button" data-dx>Закрыть</button></div>'; } }
  ];
  function hidePanel() { panel.hidden = true; panel.innerHTML = ''; scrim.hidden = true; }
  function showRoute() {
    const steps = routeSteps(); UI.route.pos = { x: 340, y: 262 };
    const R = AI.Routing, c = UI.route.ctxFor ? UI.route.ctxFor() : null; if (!c) return;
    const res = R.evaluate(steps, 0, c); if (!res || res.type === 'wait') { panel.hidden = false; scrim.hidden = false; panel.innerHTML = '<div class="rt-card"><p class="rt-l1">Подходящей замены сейчас нет</p></div>'; return; }
    const d = UI.route.describe(res, c); const before = routeSteps(); R.apply(steps, res);
    const nm = s => s.ex[0] + (s.orig ? '' : '');
    panel.innerHTML = `<div class="rt-demo"><div class="rt-plan"><small class="ai-cap dark">ПЛАН</small>${before.map((s, k) => `<div class="rp ${k === 0 ? 'bad' : ''}"><i>${k + 1}</i>${esc(s.ex[0])}${k === 0 ? `<em>ждать ~${d.waitBefore} мин</em>` : ''}</div>`).join('')}</div><div class="rt-arrow">↓</div>${UI.routeCard(d).replace('<button type="button" class="rt-undo" data-routeundo>Вернуть как было</button>', '')}</div>`;
    panel.hidden = false; scrim.hidden = false;
  }
  function startCoach() {
    const plan = AI.SimulatedPoseProvider.defaultPlan('squat', 10).map((p, i) => i === 6 ? { depth: 1.04, a: 0.95, b: 1.0, asym: 0 } : { depth: 1.03, a: 2.3, b: 2.2, asym: 0 });
    UI.coach.ex = 'squat'; UI.coach.idm = 'nfc'; UI.coach.consent = true; D.savedConsent = P.consent.coach; P.consent.coach = true;
    B.go('coach'); UI.coachStart({ sid: 'A7F3', plan, speed: 1.7, ffTo: 5, scenario: true });
  }

  /* ---------- управление ---------- */
  const bar = $('[data-demo-prog]', layer);
  function renderBar() {
    bar.innerHTML = STEPS.map((s, k) => `<i class="${k < D.i ? 'done' : k === D.i ? 'cur' : ''}"><u style="width:${k < D.i ? 100 : k === D.i && s.dur ? Math.min(100, D.el / s.dur * 100) : k === D.i ? 100 : 0}%"></u></i>`).join('');
    const s = STEPS[D.i]; $('[data-demo-n]', layer).textContent = (D.i + 1) + ' / ' + STEPS.length; $('[data-demo-title]', layer).textContent = s.t; const cp = $('[data-demo-cap]', layer); if (cp._k !== D.i) { cp._k = D.i; cp.textContent = s.cap; cp.classList.remove('fade'); void cp.offsetWidth; cp.classList.add('fade'); } $('[data-dplay]', layer).textContent = D.paused ? '▶' : '❚❚';
    layer.classList.toggle('is-final', D.i === STEPS.length - 1);
  }
  function go(i) {
    const prev = STEPS[D.i]; if (D.started && prev && prev.leave) { try { prev.leave(); } catch (e) { console.error(e); } }
    D.i = Math.max(0, Math.min(STEPS.length - 1, i)); D.el = 0; D.started = true; D.fired = {};
    const s = STEPS[D.i]; try { s.enter(); } catch (e) { console.error(e); } renderBar();
  }
  function tick() {
    if (!D.on || D.paused) return; const s = STEPS[D.i]; D.el += 100; if (s.tick) s.tick(D.el);
    if (s.dur && D.el >= s.dur) go(D.i + 1); else if (D.el % 500 === 0) renderBar();
  }
  function start() {
    if (D.on) return;
    if (orch.mode === 'LIVE') { orch.setDemo(); orch.attachScenario(scen); B.toast('Сценарий работает на демо-данных'); }
    D.saved = { role: P.role, consent: P.consent.coach, prefsTab: UI.prefs.tab, tabs: UI.prefs.layers }; D.on = true; D.paused = false; D.started = false;
    B.closeSheet({ silent: true }); D.savedSoon = B.state.lastSoon; B.state.lastSoon = performance.now() + 1e8; scen.start(); UI.refresh(); layer.hidden = false; B.app.classList.add('has-demo');
    clearInterval(D.timer); D.timer = setInterval(tick, 100); go(0);
  }
  function stop() {
    if (!D.on) return; const s = STEPS[D.i]; if (s && s.leave) { try { s.leave(); } catch (e) { /* ничего */ } }
    D.on = false; clearInterval(D.timer); scen.stop(); orch.setAuto(false); hidePanel(); full.hidden = true; layer.hidden = true; B.app.classList.remove('has-demo');
    B.state.lastSoon = performance.now(); if (D.saved) { if (D.saved.role !== P.role) P.setRole(D.saved.role); P.consent.coach = D.saved.consent; UI.prefs.tab = D.saved.prefsTab; }
    if (UI.coach) { UI.coach.sess = null; UI.coach.phase = 'intro'; }
    UI.refresh(); B.go('home');
  }
  layer.addEventListener('click', e => {
    const t = e.target;
    if (t.closest('[data-dx]')) stop(); else if (t.closest('[data-dnext]')) go(D.i + 1); else if (t.closest('[data-dprev]')) go(D.i - 1);
    else if (t.closest('[data-dplay]')) { D.paused = !D.paused; renderBar(); } else if (t.closest('[data-dreplay]')) go(0);
  });
  addEventListener('keydown', e => { if (!D.on) return; if (e.key === 'ArrowRight') go(D.i + 1); else if (e.key === 'ArrowLeft') go(D.i - 1); else if (e.key === ' ' && e.target === document.body) { e.preventDefault(); D.paused = !D.paused; renderBar(); } else if (e.key === 'Escape') stop(); });
  B.acts.demo = start; UI.demo = { start, stop, go, state: D, steps: STEPS, scen };
  if (/[#?&](demo)\b/.test(location.hash + location.search)) setTimeout(start, 2200);
})();
