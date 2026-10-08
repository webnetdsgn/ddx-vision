/* =====================================================================
   DDX Vision — Body Twin, AI Progress Engine, Return Engine.
   Все показатели считаются детерминированно по истории тренировок и замерам.
   Если данных мало или нет согласия на источник — честно показываем INSUFFICIENT DATA,
   а не выдуманный прогноз. Генеративный слой только пересказывает готовые числа и
   проходит проверку: ни одного числа, которого нет в фактах.
   ===================================================================== */
(function (root) {
  'use strict';
  const AI = root.DDXAI = root.DDXAI || {};
  const U = AI.util;
  const clamp = U.clamp, rng = U.rng, plural = U.plural;
  const f1 = v => String(Math.round(v * 10) / 10).replace('.', ',');

  /* ============================================================ демо-участники */
  // День 0 — сегодня, отрицательные числа — дни назад. Данные демонстрационные.
  const PROFILES = [
    { id: 'pro', ru: 'Опытный', desc: '16 недель истории, замеры InBody' },
    { id: 'new', ru: 'Новый', desc: 'Две тренировки, замеров нет' },
    { id: 'back', ru: 'Возвращение', desc: 'Перерыв 9 дней' }
  ];
  const LIFTS = { bench: { ru: 'жим от груди', muscle: 'chest', mru: 'грудь', base: 70 }, squat: { ru: 'приседания', muscle: 'legs', mru: 'ноги', base: 90 }, lat: { ru: 'тяга верхнего блока', muscle: 'back', mru: 'спина', base: 60 }, ohp: { ru: 'жим плечами', muscle: 'shoulders', mru: 'плечи', base: 40 } };
  const LIFT_IDS = Object.keys(LIFTS);
  const e1rm = (kg, reps) => kg * (1 + reps / 30);
  const half = v => Math.round(v * 2) / 2;
  const SPLIT = [['bench', 'ohp'], ['squat'], ['lat']]; // дни А / Б / В

  function mkSession(day, idx, done, rand, growth, minutes) {
    const lifts = (SPLIT[idx % 3]).map(l => {
      const reps = [6, 7, 8][(idx + (l === 'ohp' ? 1 : 0)) % 3], prog = 1 + growth[l] * (day + 112) / 112, kg = half(LIFTS[l].base * prog / (1 + reps / 30) * (1 + (rand() - 0.5) * 0.02));
      return { lift: l, kg, reps };
    });
    const volume = Math.round(lifts.reduce((a, x) => a + x.kg * x.reps * 3.4, 0) * 1.15);
    return { day, planned: true, done, minutes: done ? minutes : 0, muscles: lifts.map(x => LIFTS[x.lift].muscle), lifts: done ? lifts : [], volume: done ? volume : 0 };
  }
  function buildPro(seed, o) {
    o = o || {}; const rand = rng('pro' + seed), growth = { bench: 0.18, squat: 0.14, lat: 0.15, ohp: 0.13 }, sessions = [];
    const last28 = o.last28 || [-1, -3, -5, -8, -10, -12, -15, -17, -19, -22, -25], miss28 = o.miss28 || [-12, -19];
    const prev28 = [-29, -31, -33, -36, -38, -40, -43, -45, -47, -50, -53], miss56 = o.miss56 || [-31, -38, -45];
    const older = []; for (let d = -57; d >= -112; d -= 2) older.push(d);
    let k = 0;
    older.slice().reverse().forEach(d => { sessions.push(mkSession(d, k++, rand() > 0.12, rand, growth, 55)); });
    prev28.slice().reverse().forEach(d => sessions.push(mkSession(d, k++, miss56.indexOf(d) < 0, rand, growth, 54)));
    last28.slice().reverse().forEach(d => sessions.push(mkSession(d, k++, miss28.indexOf(d) < 0, rand, growth, 58)));
    const inbody = [[-84, 78.4, 33.0, 21.5], [-63, 78.9, 33.6, 20.8], [-42, 79.2, 34.2, 20.1], [-21, 79.4, 34.8, 19.5], [-3, 79.8, 35.34, 18.9]].map(a => ({ day: a[0], weight: a[1], smm: a[2], fat: a[3], source: 'InBody' }));
    return { sessions, inbody, goal: { type: 'muscle', ru: 'Набрать 3 кг мышечной массы', baseline: 33.0, target: 36.0, deadline: 22 } };
  }
  function buildNew() {
    const rand = rng('new'), growth = { bench: 0, squat: 0, lat: 0, ohp: 0 };
    return { sessions: [mkSession(-5, 0, true, rand, growth, 41), mkSession(-2, 1, true, rand, growth, 44)], inbody: [], goal: { type: 'muscle', ru: 'Набрать 3 кг мышечной массы', baseline: null, target: 36.0, deadline: 60 } };
  }
  function buildBack() {
    // последняя тренировка 9 дней назад; месяцем раньше ходил регулярно
    const pro = buildPro('back', { last28: [-2, -5, -9, -13, -16, -20, -25], miss28: [-2, -5, -16], miss56: [-31] });
    pro.inbody = pro.inbody.filter(m => m.day <= -40); return pro;
  }
  const _cache = {};
  function makeMember(profileId) {
    if (_cache[profileId]) return _cache[profileId];
    const b = profileId === 'new' ? buildNew() : profileId === 'back' ? buildBack() : buildPro(profileId);
    const m = Object.assign({ id: 'M-' + (4800 + (profileId === 'pro' ? 21 : profileId === 'new' ? 77 : 53)), profileId, targets: { perWeek: 3, legsPerWeek: 2, usualGoal: 'chest' } }, b);
    // калибровка демо-данных под показатели презентации (+14% сила, +11% объём); сам движок ниже не подгоняется
    if (profileId === 'pro') calibrate(m, 0.14, 0.11);
    _cache[profileId] = m; return m;
  }
  function calibrate(m, wantStrength, wantVolume) {
    for (let i = 0; i < 8; i++) {
      const s = strengthOf(m, { workouts: true }); if (s.state !== 'ok' || Math.round(s.pct * 100) === Math.round(wantStrength * 100)) break;
      const f = (1 + wantStrength) / (1 + s.pct); m.sessions.forEach(x => { if (x.day >= -27) x.lifts.forEach(l => { l.kg = half(l.kg * f); }); });
    }
    const v = volumeOf(m, { workouts: true });
    if (v.state === 'ok') { const f = (1 + wantVolume) / (1 + v.pct); m.sessions.forEach(x => { if (x.day >= -27) x.volume = Math.round(x.volume * f); }); }
  }

  /* ============================================================ показатели Body Twin */
  const W = { recent: [-27, 0], prev: [-55, -28], base: [-84, -57] };
  const inWin = (d, w) => d >= w[0] && d <= w[1];
  const ok = (src, k) => !src || src[k] !== false;
  const lifts = (m, w) => { const r = {}; LIFT_IDS.forEach(l => { r[l] = []; }); m.sessions.forEach(s => { if (s.done && inWin(s.day, w)) s.lifts.forEach(x => r[x.lift].push(e1rm(x.kg, x.reps))); }); return r; };
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  function strengthOf(m, src) {
    if (!ok(src, 'workouts')) return { state: 'insufficient', reason: 'consent' };
    const rec = lifts(m, W.recent), base = lifts(m, W.base), per = {}; let used = 0, sum = 0;
    LIFT_IDS.forEach(l => { if (rec[l].length >= 3 && base[l].length >= 3) { per[l] = mean(rec[l]) / mean(base[l]) - 1; used++; sum += per[l]; } });
    if (used < 2) return { state: 'insufficient', reason: 'few' };
    // за месяц: последние 4 недели против предыдущих 4
    const pv = lifts(m, W.prev), month = {}; LIFT_IDS.forEach(l => { if (rec[l].length >= 3 && pv[l].length >= 3) month[l] = mean(rec[l]) / mean(pv[l]) - 1; });
    return { state: 'ok', pct: sum / used, perLift: per, month, windowWeeks: 12 };
  }
  function volumeOf(m, src) {
    if (!ok(src, 'workouts')) return { state: 'insufficient', reason: 'consent' };
    const sum = w => { const d = m.sessions.filter(s => s.done && inWin(s.day, w)); return { n: d.length, v: d.reduce((a, s) => a + s.volume, 0) }; };
    const r = sum(W.recent), p = sum(W.prev);
    if (r.n < 4 || p.n < 4) return { state: 'insufficient', reason: 'few' };
    return { state: 'ok', pct: r.v / p.v - 1, recent: r.v, prev: p.v };
  }
  function consistencyOf(m, src) {
    if (!ok(src, 'workouts')) return { state: 'insufficient', reason: 'consent' };
    const cnt = w => { const d = m.sessions.filter(s => s.planned && inWin(s.day, w)); return { planned: d.length, done: d.filter(s => s.done).length }; };
    const r = cnt(W.recent), p = cnt(W.prev);
    if (r.planned < 6) return { state: 'insufficient', reason: 'few' };
    return { state: 'ok', pct: r.done / r.planned, planned: r.planned, done: r.done, prevPct: p.planned >= 6 ? p.done / p.planned : null };
  }
  function bodyOf(m, src) {
    if (!ok(src, 'inbody')) return { state: 'insufficient', reason: 'consent' };
    const arr = m.inbody.slice().sort((a, b) => a.day - b.day), last = arr[arr.length - 1];
    if (!last) return { state: 'insufficient', reason: 'none' };
    return { state: 'ok', ageDays: -last.day, smm: last.smm, fat: last.fat, weight: last.weight, source: last.source, stale: -last.day > 45, series: arr };
  }
  function goalOf(m, src) {
    if (!ok(src, 'inbody')) return { state: 'insufficient', status: 'INSUFFICIENT DATA', reason: 'consent' };
    const arr = m.inbody.slice().sort((a, b) => a.day - b.day);
    if (arr.length < 3 || arr[arr.length - 1].day - arr[0].day < 21 || m.goal.baseline == null) return { state: 'insufficient', status: 'INSUFFICIENT DATA', reason: arr.length ? 'few' : 'none' };
    const g = m.goal, cur = arr[arr.length - 1], progress = clamp((cur.smm - g.baseline) / (g.target - g.baseline), 0, 1.2);
    // наклон по методу наименьших квадратов, кг/день
    const n = arr.length, mx = mean(arr.map(a => a.day)), my = mean(arr.map(a => a.smm));
    const slope = arr.reduce((s, a) => s + (a.day - mx) * (a.smm - my), 0) / arr.reduce((s, a) => s + (a.day - mx) * (a.day - mx), 0);
    const daysLeft = Math.max(1, g.deadline - cur.day), need = (g.target - cur.smm) / daysLeft, ratio = need <= 0 ? 9 : slope / need;
    const status = progress >= 1 ? 'AHEAD' : ratio >= 1.5 ? 'AHEAD' : ratio >= 0.9 ? 'ON TRACK' : ratio >= 0.5 ? 'BEHIND' : 'OFF TRACK';
    return { state: 'ok', status, progress, current: cur.smm, baseline: g.baseline, target: g.target, ru: g.ru, slope, daysLeft, projected: cur.smm + slope * daysLeft, points: n };
  }
  function freqOf(m, src) {
    if (!ok(src, 'workouts')) return { state: 'insufficient', reason: 'consent' };
    const d = m.sessions.filter(s => s.done && inWin(s.day, W.recent));
    if (d.length < 4) return { state: 'insufficient', reason: 'few' };
    const per = {}; ['chest', 'legs', 'back', 'shoulders'].forEach(k => { per[k] = d.filter(s => s.muscles.indexOf(k) >= 0).length / 4; });
    return { state: 'ok', perWeek: per };
  }
  function nextLoad(m, src) {
    if (!ok(src, 'workouts')) return null;
    const out = {}; LIFT_IDS.forEach(l => {
      const tops = m.sessions.filter(s => s.done).map(s => ({ day: s.day, x: s.lifts.find(y => y.lift === l) })).filter(a => a.x).slice(-2);
      if (tops.length < 2) return; const reps = tops.map(a => a.x.reps);
      out[l] = reps.every(r => r >= 8) ? 'up' : reps.some(r => r < 6) ? 'down' : 'keep';
    });
    return out;
  }
  function bodyTwin(m, src) {
    return { strength: strengthOf(m, src), consistency: consistencyOf(m, src), volume: volumeOf(m, src), body: bodyOf(m, src), goal: goalOf(m, src), freq: freqOf(m, src), next: nextLoad(m, src), memberId: m.id };
  }
  AI.Members = { PROFILES, make: makeMember, LIFTS };

  /* ---------- провайдеры данных участника (в боевом режиме — HTTP-адаптеры из core.js) ---------- */
  const PR = AI.providers || {};
  class DemoWorkoutProvider extends (PR.WorkoutProvider || Object) { history(profileId) { return makeMember(profileId).sessions; } }
  class DemoBodyCompositionProvider extends (PR.BodyCompositionProvider || Object) { series(profileId) { return makeMember(profileId).inbody; } }
  // временная сессия Vision Coach: браслет / NFC / QR / BLE → псевдоним сессии, лицо не используется
  class DemoIdentityProvider extends (PR.IdentityProvider || Object) {
    constructor() { super(); this.n = 0; this.open_ = {}; }
    open(method, zone) { const id = 'S' + (0xA00 + (++this.n * 37) % 0x5ff).toString(16).toUpperCase(); this.open_[id] = { id, method, zone, since: Date.now(), ttlMin: 90 }; return this.open_[id]; }
    close(id) { const s = this.open_[id]; delete this.open_[id]; return !!s; }
  }
  AI.registry = { workout: new DemoWorkoutProvider(), body: new DemoBodyCompositionProvider(), identity: new DemoIdentityProvider() };
  // собрать участника из провайдеров (так же это сделает боевой режим)
  AI.loadMember = function (profileId) { const m = makeMember(profileId); return Object.assign({}, m, { sessions: AI.registry.workout.history(profileId), inbody: AI.registry.body.series(profileId) }); };
  AI.bodyTwin = bodyTwin;

  /* ============================================================ AI PROGRESS ENGINE */
  // Факты: числа из движков. Пояснение — слой над фактами.
  function progressFacts(bt) {
    const F = [];
    if (bt.strength.state === 'ok') {
      const best = Object.keys(bt.strength.month || {}).sort((a, b) => bt.strength.month[b] - bt.strength.month[a])[0];
      if (best) F.push({ k: 'lift_month', lift: best, value: Math.round(bt.strength.month[best] * 100), days: 30 });
      F.push({ k: 'strength_total', value: Math.round(bt.strength.pct * 100), weeks: bt.strength.windowWeeks });
    }
    if (bt.consistency.state === 'ok') F.push({ k: 'consistency', value: Math.round(bt.consistency.pct * 100), prev: bt.consistency.prevPct != null ? Math.round(bt.consistency.prevPct * 100) : null });
    if (bt.freq.state === 'ok') {
      const legs = bt.freq.perWeek.legs; if (legs < 2) F.push({ k: 'legs_freq', value: f1(legs), target: 2 });
    }
    if (bt.next) { const l = LIFT_IDS.find(x => bt.next[x] === 'keep'); if (l) F.push({ k: 'keep_load', lift: l }); const up = LIFT_IDS.find(x => bt.next[x] === 'up'); if (up) F.push({ k: 'raise_load', lift: up, value: '2,5' }); }
    if (bt.goal.state === 'ok') F.push({ k: 'goal', value: Math.round(Math.min(1, bt.goal.progress) * 100), status: bt.goal.status });
    return F;
  }
  const TEMPL = {
    lift_month: f => 'Ваша сила в упражнении «' + LIFTS[f.lift].ru + '» ' + (f.value >= 2 ? 'выросла на ' + f.value + '% за последние ' + f.days + ' дней.' : f.value <= -2 ? 'снизилась на ' + Math.abs(f.value) + '% за последние ' + f.days + ' дней.' : 'почти не изменилась за последние ' + f.days + ' дней.'),
    strength_total: f => 'За ' + f.weeks + ' недель общая сила выросла на ' + f.value + '%.',
    consistency: f => f.prev == null ? 'Вы выполнили ' + f.value + '% запланированных тренировок за месяц.' : (f.value > f.prev ? 'Регулярность улучшилась: ' + f.value + '% против ' + f.prev + '% в прошлом месяце.' : f.value < f.prev ? 'Регулярность снизилась: ' + f.value + '% против ' + f.prev + '% в прошлом месяце.' : 'Регулярность держится на уровне ' + f.value + '%.'),
    legs_freq: f => 'Ноги вы тренировали реже, чем требует цель: ' + f.value + ' раза в неделю при плане ' + f.target + '.',
    keep_load: f => 'По последним тренировкам в упражнении «' + LIFTS[f.lift].ru + '» сохраните текущий вес, прежде чем повышать.',
    raise_load: f => 'В упражнении «' + LIFTS[f.lift].ru + '» можно добавить ' + f.value + '% к весу: две тренировки подряд вы выполняли верхнюю границу повторов.',
    goal: f => 'До цели пройдено ' + f.value + '% пути.'
  };
  function explainTemplate(facts) { return facts.map(f => TEMPL[f.k](f)); }
  // защита: в тексте нет чисел, которых нет в фактах
  function numbersOf(s) { return (String(s).match(/\d+(?:[.,]\d+)?/g) || []).map(x => x.replace(',', '.')); }
  function allowedNumbers(facts) { const set = new Set(); facts.forEach(f => Object.keys(f).forEach(k => { if (k !== 'k') numbersOf(f[k]).forEach(n => set.add(n)); })); return set; }
  function guardNumbers(texts, facts) {
    const allow = allowedNumbers(facts), bad = [];
    texts.forEach(t => numbersOf(t).forEach(n => { if (!allow.has(n)) bad.push(n); }));
    return { ok: bad.length === 0, bad };
  }
  class ExplainerProvider { async explain() { throw new Error('ExplainerProvider.explain не реализован'); } }
  class TemplateExplainer extends ExplainerProvider { async explain(facts) { return explainTemplate(facts); } }
  class LlmExplainer extends ExplainerProvider { constructor(cfg) { super(); this.cfg = cfg || {}; } async explain() { throw new Error('LLM не подключён: нужен ключ и адрес сервиса'); } }
  async function safeExplain(provider, facts) {
    try { const out = await provider.explain(facts); const g = guardNumbers(out, facts); if (g.ok) return { lines: out, by: provider.constructor.name }; } catch (e) { /* падаем на шаблон */ }
    return { lines: explainTemplate(facts), by: 'TemplateExplainer', fallback: true };
  }
  AI.Progress = { facts: progressFacts, explainTemplate, guardNumbers, ExplainerProvider, TemplateExplainer, LlmExplainer, safeExplain };

  /* ============================================================ RETURN ENGINE */
  // Операционный сигнал вовлечённости: NORMAL / WATCH / DECLINING. Сотрудникам — только сигнал и обезличенный номер.
  const SIGNAL = { NORMAL: { ru: 'Норма', c: '#0FA866' }, WATCH: { ru: 'Наблюдать', c: '#E89A0C' }, DECLINING: { ru: 'Снижение вовлечённости', c: '#E5483D' } };
  function retentionOf(visits) { // visits: [{day, done, planned}]
    const done = visits.filter(v => v.done), last = done.length ? Math.max(...done.map(v => v.day)) : -999, daysSince = -last;
    const f28 = done.filter(v => inWin(v.day, W.recent)).length, p28 = done.filter(v => inWin(v.day, W.prev)).length, ratio = p28 >= 8 ? f28 / p28 : 1;
    const planned = visits.filter(v => v.planned && inWin(v.day, W.recent)), incomplete = planned.length >= 4 ? 1 - planned.filter(v => v.done).length / planned.length : 0;
    let signal = 'NORMAL';
    // порог по доле учитывает естественный разброс визитов: сравниваем только при достаточной истории (≥8 визитов)
    const hist = p28 >= 8;
    if (daysSince > 14 || (hist && ratio <= 0.4)) signal = 'DECLINING';
    else if (daysSince > 7 || (hist && ratio < 0.6) || incomplete > 0.5) signal = 'WATCH';
    const why = []; if (daysSince > 7) why.push('прошло ' + daysSince + ' ' + plural(daysSince, ['день', 'дня', 'дней']) + ' с последней тренировки'); if (hist && ratio < 0.6) why.push('частота визитов снизилась'); if (incomplete > 0.5) why.push('часть тренировок остаётся незавершённой');
    return { signal, daysSince, f28, p28, ratio, incomplete, why };
  }
  function welcomeBack(daysSince) {
    const cut = daysSince >= 30 ? 35 : daysSince >= 14 ? 25 : daysSince >= 7 ? 15 : 0;
    return { lastDays: daysSince, minutes: 38, exercises: 5, loadCutPct: cut, text: cut ? 'Стартовая нагрузка на ' + cut + '% ниже обычной' : 'Обычная нагрузка' };
  }
  // обезличенная выборка клуба для Command Center
  const _coh = {};
  function cohort(clubId, size) {
    const key = clubId + ':' + size; if (_coh[key]) return _coh[key];
    const r = rng('cohort' + clubId), counts = { NORMAL: 0, WATCH: 0, DECLINING: 0 }, flagged = [];
    for (let i = 0; i < size; i++) {
      const kind = r(), visits = []; let k = 0;
      const regular = kind < 0.86, gap = kind >= 0.86 && kind < 0.94, fade = kind >= 0.94 && kind < 0.97;
      for (let d = -55; d <= -1; d++) {
        let p = 0.42; if (gap && d > -12 - Math.floor(r() * 4)) p = 0.04; if (fade && d > -28) p = 0.1; if (!regular && !gap && !fade && d > -20) p = 0.05; if (regular) p = 0.42 + (r() - 0.5) * 0.08;
        if (r() < p) visits.push({ day: d, done: true, planned: true });
      }
      const s = retentionOf(visits); counts[s.signal]++;
      if (s.signal === 'DECLINING' && flagged.length < 40) flagged.push({ id: 'M-' + (1000 + Math.floor(r() * 8999)), daysSince: s.daysSince, f28: s.f28, p28: s.p28, why: s.why });
    }
    return (_coh[key] = { size, counts, flagged: flagged.sort((a, b) => b.daysSince - a.daysSince).slice(0, 5) });
  }
  AI.Return = { SIGNAL, of: retentionOf, welcome: welcomeBack, cohort, ofMember: m => retentionOf(m.sessions) };

  // план «Welcome back» из упражнений цели: 5 упражнений, на подход меньше
  AI.welcomePlan = function (goalEx, daysSince) {
    const w = welcomeBack(daysSince), idx = [0, 1, 2, 3, goalEx.length - 1].filter((v, i, a) => a.indexOf(v) === i && v < goalEx.length);
    return { info: w, ex: idx.map(i => { const e = goalEx[i]; return [e[0], e[1], e[2] > 1 ? Math.max(2, e[2] - 1) : 1]; }) };
  };
})(typeof window !== 'undefined' ? window : globalThis);
