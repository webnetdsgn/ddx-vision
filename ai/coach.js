/* =====================================================================
   DDX Vision — Vision Coach.
   Конвейер: поза (PoseProvider) → распознавание упражнения → счётчик повторов →
   метрики движения (диапазон, темп, симметрия) → одна короткая подсказка.
   Это тренировочные подсказки, а не медицинская оценка.
   В демо позу выдаёт симулятор скелета; боевой PoseProvider (MediaPipe / MoveNet / edge-сервис)
   подключается через тот же интерфейс read(dt) → { t, kp3, kp2 } без изменения остального кода.
   Видео не используется и не хранится: на вход приходят только ключевые точки.
   ===================================================================== */
(function (root) {
  'use strict';
  const AI = root.DDXAI = root.DDXAI || {};
  const U = AI.util || {};
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v)), lerp = (a, b, t) => a + (b - a) * t, RAD = Math.PI / 180;
  const rng = U.rng || (seed => { let a = seed >>> 0; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; });

  /* ---------- ключевые точки (набор COCO-17) ---------- */
  const KP = { nose: 0, leye: 1, reye: 2, lear: 3, rear: 4, lsh: 5, rsh: 6, lel: 7, rel: 8, lwr: 9, rwr: 10, lhip: 11, rhip: 12, lkn: 13, rkn: 14, lank: 15, rank: 16 };
  const BONES = [[5, 6], [5, 7], [7, 9], [6, 8], [8, 10], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [0, 1], [0, 2], [1, 3], [2, 4]];
  const LEN = { shin: 0.43, thigh: 0.43, torso: 0.5, up: 0.3, fore: 0.28 };
  AI.KP = KP; AI.BONES = BONES;

  /* ---------- упражнения ---------- */
  // sStart / sEffort — значение сигнала (угол, °) в исходном положении и в точке усилия
  const EX = {
    squat: { id: 'squat', en: 'SQUAT', ru: 'Приседание', sStart: 172, sEffort: 95, ecc: 'A', plan: 'Приседания', zone: 'Зона приседаний' },
    lunge: { id: 'lunge', en: 'LUNGE', ru: 'Выпад', sStart: 165, sEffort: 92, ecc: 'A', plan: 'Выпады с гантелями', zone: 'Зона приседаний' },
    press: { id: 'press', en: 'SHOULDER PRESS', ru: 'Жим плечами', sStart: 88, sEffort: 168, ecc: 'B', plan: 'Жим вверх', zone: 'Зона гантелей' },
    curl: { id: 'curl', en: 'BICEPS CURL', ru: 'Сгибание на бицепс', sStart: 172, sEffort: 44, ecc: 'B', plan: 'Сгибание на бицепс', zone: 'Зона гантелей' },
    lateral: { id: 'lateral', en: 'LATERAL RAISE', ru: 'Разведение в стороны', sStart: 8, sEffort: 88, ecc: 'B', plan: 'Разведение в стороны', zone: 'Зона гантелей' }
  };
  const EXLIST = ['squat', 'lunge', 'press', 'curl', 'lateral'];
  AI.COACH_EX = EX; AI.COACH_EXLIST = EXLIST;

  /* ---------- векторы ---------- */
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm3 = a => Math.hypot(a[0], a[1], a[2]);
  function angle(A, B, C) { const u = sub(A, B), v = sub(C, B), d = norm3(u) * norm3(v); return d ? Math.acos(clamp(dot(u, v) / d, -1, 1)) / RAD : 0; }
  AI.angle3 = angle;

  /* ---------- симулятор скелета ---------- */
  function leg(ankle, theta, phi) {
    // голень наклонена вперёд на phi, угол в колене theta; бедро уходит назад-вверх
    const az = -Math.sin(phi), ay = -Math.cos(phi), th = theta * RAD, c = Math.cos(th), s = Math.sin(th);
    const knee = [ankle[0], ankle[1] + LEN.shin * Math.cos(phi), ankle[2] + LEN.shin * Math.sin(phi)];
    const vz = az * c + ay * s, vy = -az * s + ay * c, n = Math.hypot(vz, vy);
    return { knee, hip: [ankle[0], knee[1] + LEN.thigh * vy / n, knee[2] + LEN.thigh * vz / n] };
  }
  function ik2(R, T, l1, l2, pole) {
    // сустав посередине двухзвенной цепи: R — корень, T — конец; pole задаёт сторону изгиба
    let d = sub(T, R), dist = norm3(d); const mx = l1 + l2 - 1e-4; if (dist > mx) { d = d.map(v => v * mx / dist); dist = mx; }
    if (dist < 1e-4) return R.slice();
    const dir = d.map(v => v / dist), a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    let pv = sub(pole, dir.map(v => v * dot(pole, dir))); const pn = norm3(pv); pv = pn < 1e-6 ? [0, 0, 1] : pv.map(v => v / pn);
    return [R[0] + dir[0] * a + pv[0] * h, R[1] + dir[1] * a + pv[1] * h, R[2] + dir[2] * a + pv[2] * h];
  }
  function standLegs(o, thL, thR, phi) {
    const L = leg([-0.11, 0.08, 0], thL, phi), R = leg([0.11, 0.08, 0], thR, phi);
    o.lank = [-0.11, 0.08, 0]; o.rank = [0.11, 0.08, 0]; o.lkn = L.knee.slice(); o.rkn = R.knee.slice(); o.lkn[0] = -0.115; o.rkn[0] = 0.115; o.lhip = L.hip.slice(); o.rhip = R.hip.slice(); o.lhip[0] = -0.1; o.rhip[0] = 0.1;
  }
  function upper(o, lean) {
    const M = [0, (o.lhip[1] + o.rhip[1]) / 2, (o.lhip[2] + o.rhip[2]) / 2], tilt = (o.rhip[1] - o.lhip[1]) * 0.6;
    const S = [0, M[1] + LEN.torso * Math.cos(lean), M[2] + LEN.torso * Math.sin(lean)];
    o.lsh = [-0.19, S[1] + tilt, S[2]]; o.rsh = [0.19, S[1] - tilt, S[2]];
    const hl = lean * 0.7, H = [0, S[1] + 0.22 * Math.cos(hl), S[2] + 0.22 * Math.sin(hl)];
    o.nose = [0, H[1] - 0.02, H[2] + 0.09]; o.leye = [-0.032, H[1] + 0.03, H[2] + 0.08]; o.reye = [0.032, H[1] + 0.03, H[2] + 0.08]; o.lear = [-0.08, H[1] + 0.02, H[2]]; o.rear = [0.08, H[1] + 0.02, H[2]];
  }
  function armsHang(o, fwd) { // руки опущены
    ['l', 'r'].forEach((k, i) => { const sg = i ? 1 : -1, S = o[k + 'sh'], W = [S[0] + sg * 0.05, S[1] - 0.55, S[2] + (fwd || 0.04)]; o[k + 'wr'] = W; o[k + 'el'] = ik2(S, W, LEN.up, LEN.fore, [0, 0, -1]); });
  }
  const POSE = {
    squat(o, dL, dR) {
      const ex = EX.squat, th = d => lerp(ex.sStart, ex.sEffort, d), dm = (dL + dR) / 2, phi = lerp(2, 24, clamp(dm, 0, 1.2)) * RAD;
      standLegs(o, th(dL), th(dR), phi); upper(o, lerp(2, 36, clamp(dm, 0, 1.2)) * RAD);
      ['l', 'r'].forEach((k, i) => { const sg = i ? 1 : -1, S = o[k + 'sh'], W = [S[0] + sg * 0.06, S[1] - 0.04, S[2] + 0.5]; o[k + 'wr'] = W; o[k + 'el'] = ik2(S, W, LEN.up, LEN.fore, [0, -1, 0]); });
    },
    lunge(o, d, _d2, asym) {
      const ex = EX.lunge, thF = lerp(ex.sStart, ex.sEffort, d), dist = 0.86 * Math.sin(thF * RAD / 2), zF = 0.38, hy = 0.08 + Math.sqrt(Math.max(0, dist * dist - zF * zF));
      const fa = [-0.1, 0.08, zF], ra = [0.1, 0.16, -zF], hL = [-0.1, hy, 0], hR = [0.1, hy, 0];
      o.lank = fa; o.rank = ra; o.lhip = hL; o.rhip = hR;
      o.lkn = ik2(hL, fa, LEN.thigh, LEN.shin, [0, 0.4, 1]); o.rkn = ik2(hR, ra, LEN.thigh, LEN.shin, [0, -1, -0.15]);
      upper(o, 0.03); const tilt = (asym || 0) * RAD * 0.5; o.lsh[1] += Math.sin(tilt) * 0.19; o.rsh[1] -= Math.sin(tilt) * 0.19; armsHang(o, 0.04);
    },
    press(o, dL, dR) {
      const ex = EX.press; standLegs(o, 176, 176, 0.02); upper(o, 0.02);
      [['l', -1, dL], ['r', 1, dR]].forEach(([k, sg, d]) => {
        const e = lerp(ex.sStart, ex.sEffort, d), rho = lerp(0, 80, clamp(d, 0, 1.2)) * RAD, S = o[k + 'sh'];
        const E = [S[0] + sg * LEN.up * Math.cos(rho), S[1] + LEN.up * Math.sin(rho), S[2] + 0.04], f = rho + (180 - e) * RAD;
        o[k + 'el'] = E; o[k + 'wr'] = [E[0] - sg * LEN.fore * Math.cos(f), E[1] + LEN.fore * Math.sin(f), E[2]];
      });
    },
    curl(o, dL, dR) {
      const ex = EX.curl; standLegs(o, 176, 176, 0.02); upper(o, 0.02);
      [['l', -1, dL], ['r', 1, dR]].forEach(([k, sg, d]) => {
        const e = lerp(ex.sStart, ex.sEffort, d), al = (180 - e) * RAD, S = o[k + 'sh'], E = [S[0] + sg * 0.04, S[1] - LEN.up, S[2] + 0.03];
        o[k + 'el'] = E; o[k + 'wr'] = [E[0], E[1] - LEN.fore * Math.cos(al), E[2] + LEN.fore * Math.sin(al)];
      });
    },
    lateral(o, dL, dR) {
      const ex = EX.lateral; standLegs(o, 176, 176, 0.02); upper(o, 0.02);
      [['l', -1, dL], ['r', 1, dR]].forEach(([k, sg, d]) => {
        const ph = lerp(ex.sStart, ex.sEffort, d) * RAD, S = o[k + 'sh'], E = [S[0] + sg * LEN.up * Math.sin(ph), S[1] - LEN.up * Math.cos(ph), S[2]], f = ph - 14 * RAD;
        o[k + 'el'] = E; o[k + 'wr'] = [E[0] + sg * LEN.fore * Math.sin(f), E[1] - LEN.fore * Math.cos(f), E[2] + 0.03];
      });
    }
  };
  const YAW = 28 * RAD;
  function project(kp3) { return kp3.map(p => [p[0] * Math.cos(YAW) + p[2] * Math.sin(YAW), p[1]]); }

  // профиль одного повтора: A — фаза усилия (вниз/вверх), B — возврат
  const smooth = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
  class SimulatedPoseProvider extends (AI.providers ? AI.providers.PoseProvider : Object) {
    constructor(opts) {
      super(); this.kind = 'pose'; this.mode = 'DEMO'; opts = opts || {};
      this.exercise = opts.exercise || 'squat'; this.noise = opts.noise == null ? 0.004 : opts.noise; this.seed = opts.seed || 7;
      this.lead = 0.9; this.gap = 0.55; this.hold = 0.14; this.t = 0; this.reps = []; this.rand = rng(this.seed);
      this.setPlan(opts.reps || SimulatedPoseProvider.defaultPlan(this.exercise, opts.count || 10));
    }
    static defaultPlan(exId, n) {
      const out = [], r = rng('plan' + exId);
      for (let i = 0; i < n; i++) out.push({ depth: clamp(1.02 + (r() - 0.5) * 0.12, 0.9, 1.15), a: 2.3 + (r() - 0.5) * 0.4, b: 2.2 + (r() - 0.5) * 0.4, asym: (r() - 0.5) * 4 });
      return out;
    }
    setPlan(plan) {
      this.plan = plan; let t = this.lead; this.reps = plan.map(p => { const r = Object.assign({ t0: t }, p); r.t1 = t + p.a + this.hold + p.b; t = r.t1 + this.gap; return r; }); this.total = t;
    }
    // эффект d(t) в [0..depth] и номер повтора
    dAt(t) {
      for (let i = 0; i < this.reps.length; i++) {
        const r = this.reps[i]; if (t < r.t0 || t >= r.t1) continue; const x = t - r.t0;
        if (x < r.a) return { d: r.depth * smooth(x / r.a), i, asym: r.asym };
        if (x < r.a + this.hold) return { d: r.depth, i, asym: r.asym };
        return { d: r.depth * (1 - smooth((x - r.a - this.hold) / r.b)), i, asym: r.asym };
      }
      return { d: 0, i: -1, asym: 0 };
    }
    frameAt(t) {
      const s = this.dAt(t), ex = EX[this.exercise], rom = Math.abs(ex.sEffort - ex.sStart), af = (s.asym || 0) / rom, o = {};
      POSE[this.exercise](o, s.d * (1 + af / 2), s.d * (1 - af / 2), s.asym);
      const keys = ['nose', 'leye', 'reye', 'lear', 'rear', 'lsh', 'rsh', 'lel', 'rel', 'lwr', 'rwr', 'lhip', 'rhip', 'lkn', 'rkn', 'lank', 'rank'];
      const rr = rng(Math.floor(t * 30) * 977 + this.seed), nz = this.noise;
      const breathe = Math.sin(t * 1.9) * 0.004;
      const kp3 = keys.map(k => o[k].map((v, a) => v + (rr() - 0.5) * 2 * nz + (a === 1 && k.indexOf('sh') >= 0 ? breathe : 0)));
      return { t, kp3, kp2: project(kp3), conf: keys.map(() => 0.9 + rr() * 0.09), d: s.d, rep: s.i, done: t > this.total };
    }
    read(dt) { this.t += dt; return this.frameAt(this.t); }
    reset() { this.t = 0; }
  }

  /* ---------- сигналы из ключевых точек ---------- */
  function signal(exId, kp) {
    const g = n => kp[KP[n]];
    if (exId === 'squat') { const l = angle(g('lhip'), g('lkn'), g('lank')), r = angle(g('rhip'), g('rkn'), g('rank')); return { v: (l + r) / 2, l, r }; }
    if (exId === 'lunge') { const l = angle(g('lhip'), g('lkn'), g('lank')), r = angle(g('rhip'), g('rkn'), g('rank')), frontL = g('lank')[2] >= g('rank')[2]; const tilt = Math.atan2(g('lsh')[1] - g('rsh')[1], g('rsh')[0] - g('lsh')[0]) / RAD - Math.atan2(g('lhip')[1] - g('rhip')[1], g('rhip')[0] - g('lhip')[0]) / RAD; return { v: frontL ? l : r, l, r, tilt: Math.abs(tilt), front: frontL ? 'L' : 'R' }; }
    if (exId === 'press' || exId === 'curl') { const l = angle(g('lsh'), g('lel'), g('lwr')), r = angle(g('rsh'), g('rel'), g('rwr')); return { v: (l + r) / 2, l, r }; }
    // отведение плеча: угол между рукой и осью корпуса (от середины плеч к середине таза)
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], axis = sub(mid(g('lhip'), g('rhip')), mid(g('lsh'), g('rsh')));
    const ab = (sh, el) => { const v = sub(el, sh), d = norm3(v) * norm3(axis); return d ? Math.acos(clamp(dot(v, axis) / d, -1, 1)) / RAD : 0; };
    const l = ab(g('lsh'), g('lel')), r = ab(g('rsh'), g('rel')); return { v: (l + r) / 2, l, r };
  }
  AI.coachSignal = signal;

  /* ---------- счётчик повторов ---------- */
  const TEMPO_K = 1.42; // поправка: измеряем от 6% хода до плато; откалибровано по симулятору, на боевых данных перепроверить
  const TEMPO_FAST = 1.4, TEMPO_SLOW = 5;
  class RepCounter {
    constructor(exId) { this.ex = EX[exId]; this.id = exId; this.reset(); }
    reset() { this.reps = []; this.partials = 0; this.state = 'start'; this.ema = null; this.buf = []; }
    u(v) { return (v - this.ex.sStart) / (this.ex.sEffort - this.ex.sStart); }
    push(t, kp) {
      const sg = signal(this.id, kp); this.ema = this.ema == null ? sg.v : this.ema + 0.45 * (sg.v - this.ema);
      const u = this.u(this.ema); let ev = null;
      if (this.state === 'start') { if (u > 0.08) { this.state = 'moving'; this.buf = []; } }
      if (this.state === 'moving') {
        this.buf.push({ t, u, l: sg.l, r: sg.r, tilt: sg.tilt });
        if (u < 0.06 && this.buf.length > 6) { ev = this.finish(t); this.state = 'start'; this.buf = []; }
      }
      return ev;
    }
    finish(tEnd) {
      const b = this.buf; let pk = -9, pi = 0; b.forEach((s, i) => { if (s.u > pk) { pk = s.u; pi = i; } });
      let hi0 = pi, hi1 = pi; b.forEach((s, i) => { if (s.u >= pk - 0.04) { if (i < hi0) hi0 = i; if (i > hi1) hi1 = i; } });
      let ls = 0; while (ls < b.length && b[ls].u < 0.06) ls++;
      const A = Math.max(0.1, (b[hi0].t - b[Math.min(ls, hi0)].t) * TEMPO_K), B = Math.max(0.1, (tEnd - b[hi1].t) * TEMPO_K);
      const ecc = this.ex.ecc === 'A' ? A : B, atPk = b[Math.floor((hi0 + hi1) / 2)];
      const rom = this.ex.sStart + (this.ex.sEffort - this.ex.sStart) * pk;
      const diff = this.id === 'lunge' ? (atPk.tilt || 0) : Math.abs(atPk.l - atPk.r), weak = atPk.l > atPk.r === (this.ex.sEffort < this.ex.sStart) ? 'L' : 'R';
      if (pk < 0.8) { this.partials++; return { type: 'partial', peakU: pk, at: tEnd }; }
      const rep = { n: this.reps.length + 1, peakU: pk, rom, A, B, ecc, diff, lagging: diff >= 8 ? weak : null, range: pk >= 0.95 ? 'GOOD' : pk >= 0.85 ? 'FAIR' : 'SHALLOW', tempo: ecc < TEMPO_FAST ? 'FAST' : ecc > TEMPO_SLOW ? 'SLOW' : 'GOOD', symmetry: diff < 8 ? 'NORMAL' : diff < 15 ? 'WATCH' : 'UNEVEN', at: tEnd };
      this.reps.push(rep); return { type: 'rep', rep };
    }
  }
  AI.RepCounter = RepCounter;

  /* ---------- распознавание упражнения по окну ключевых точек ---------- */
  class ExerciseRecognizer {
    constructor(winSec) { this.win = winSec || 3; this.buf = []; }
    push(t, kp) {
      const g = n => kp[KP[n]], sgK = signal('squat', kp), sgE = signal('press', kp);
      const elL = (g('lel')[1] + g('rel')[1]) / 2 - (g('lsh')[1] + g('rsh')[1]) / 2, wrL = (g('lwr')[1] + g('rwr')[1]) / 2 - (g('lsh')[1] + g('rsh')[1]) / 2;
      this.buf.push({ t, knee: sgK.v, elbow: sgE.v, elRel: elL, wrRel: wrL, split: Math.abs(g('lank')[2] - g('rank')[2]) });
      while (this.buf.length && t - this.buf[0].t > this.win) this.buf.shift();
    }
    result() {
      const b = this.buf; if (b.length < 10) return { id: null, conf: 0, why: 'мало данных' };
      const rg = k => Math.max(...b.map(s => s[k])) - Math.min(...b.map(s => s[k])), mean = k => b.reduce((a, s) => a + s[k], 0) / b.length;
      const kneeR = rg('knee'), elbR = rg('elbow'), riseR = rg('elRel'), wr = mean('wrRel'), split = mean('split'), elMax = Math.max(...b.map(s => s.elRel));
      const sat = (x, thr) => clamp(0.72 + 0.27 * (x - thr) / thr, 0.72, 0.99);
      if (kneeR > 30) return split > 0.45 ? { id: 'lunge', conf: sat(kneeR, 30) } : { id: 'squat', conf: sat(kneeR, 30) };
      if (wr > 0.08 && elbR > 25) return { id: 'press', conf: sat(elbR, 25) };
      if (elbR < 35 && riseR > 0.1) return { id: 'lateral', conf: sat(riseR, 0.1) };
      if (elbR > 45 && elMax < -0.15) return { id: 'curl', conf: sat(elbR, 45) };
      return { id: null, conf: 0, why: 'движение не распознано' };
    }
  }
  AI.ExerciseRecognizer = ExerciseRecognizer;

  /* ---------- подсказки: из метрик — ровно одна короткая фраза ---------- */
  const CUES = {
    partial: { squat: 'Спуститесь чуть глубже — до параллели бёдер с полом.', lunge: 'Опуститесь глубже — колено примерно под 90°.', press: 'Выжмите до полного выпрямления рук.', curl: 'Поднимайте выше — до напряжения бицепса.', lateral: 'Поднимайте руки до уровня плеч.' },
    fast: { squat: 'Опускайтесь медленнее — на 2–3 счёта.', lunge: 'Опускайтесь медленнее — на 2–3 счёта.', press: 'Опускайте вес медленнее — на 2–3 счёта.', curl: 'Опускайте вес медленнее — на 2–3 счёта.', lateral: 'Опускайте руки медленнее — на 2–3 счёта.' }
  };
  function cueFor(exId, ev, hist) {
    if (!ev) return null;
    if (ev.type === 'partial') return { code: 'partial', tone: 'warn', text: CUES.partial[exId] };
    const r = ev.rep;
    if (r.tempo === 'FAST') return { code: 'tempo_fast', tone: 'warn', text: CUES.fast[exId], en: 'Slow down the descent.' };
    if (r.symmetry !== 'NORMAL') return { code: 'asym', tone: 'warn', text: (r.lagging === 'L' ? 'Левая' : 'Правая') + ' сторона отстаёт — выровняйте движение.' };
    if (r.range === 'SHALLOW') return { code: 'rom', tone: 'warn', text: 'Добавьте амплитуду — повтор получился неполным.' };
    if (r.range === 'FAIR') return { code: 'rom_fair', tone: 'info', text: 'Почти — чуть больше амплитуды.' };
    if (r.tempo === 'SLOW') return { code: 'tempo_slow', tone: 'info', text: 'Хороший контроль. Можно чуть бодрее.' };
    return { code: 'good', tone: 'good', text: 'Хороший диапазон. Держите этот темп.', en: 'Good range. Maintain this tempo.' };
  }
  AI.coachCue = cueFor;

  /* ---------- сессия Vision Coach ---------- */
  // exercise: 'auto' или id. Пока упражнение не распознано, кадры копятся и затем пересчитываются, чтобы не терять первый повтор.
  class CoachSession {
    constructor(opts) {
      opts = opts || {}; this.provider = opts.provider; this.target = opts.target || 10; this.mode = opts.exercise && opts.exercise !== 'auto' ? 'manual' : 'auto';
      this.exercise = this.mode === 'manual' ? opts.exercise : null; this.conf = this.mode === 'manual' ? 1 : 0; this.recog = new ExerciseRecognizer(3); this.hist = []; this.log = [];
      this.counter = this.exercise ? new RepCounter(this.exercise) : null; this.last = null; this.cue = null; this.cueAt = -9; this.stable = 0; this.cand = null; this.t = 0; this.frame = null; this.sessionId = opts.sessionId || 'A7F3';
      this.ended = false;
    }
    setExercise(id) { this.mode = id === 'auto' ? 'auto' : 'manual'; this.exercise = id === 'auto' ? null : id; this.conf = id === 'auto' ? 0 : 1; this.counter = this.exercise ? new RepCounter(this.exercise) : null; this.hist = []; this.cue = null; this.last = null; this.stable = 0; this.cand = null; }
    get reps() { return this.counter ? this.counter.reps : []; }
    step(dt) {
      if (this.ended) return this.view();
      const f = this.provider.read(dt); this.frame = f; this.t = f.t;
      this.recog.push(f.t, f.kp3);
      if (!this.exercise && this.mode === 'auto') {
        this.hist.push({ t: f.t, kp: f.kp3 }); if (this.hist.length > 400) this.hist.shift();
        const r = this.recog.result();
        if (r.id && r.conf >= 0.8) { if (this.cand === r.id) this.stable += dt; else { this.cand = r.id; this.stable = 0; } this.conf = r.conf; } else { this.cand = null; this.stable = 0; }
        if (this.cand && this.stable >= 0.4) { this.exercise = this.cand; this.counter = new RepCounter(this.exercise); this.hist.forEach(h => this.feed(h.t, h.kp)); this.hist = []; }
      } else if (this.counter) this.feed(f.t, f.kp3);
      return this.view();
    }
    feed(t, kp) {
      const ev = this.counter.push(t, kp);
      if (ev) { this.last = ev; this.cue = cueFor(this.exercise, ev); this.cueAt = t; this.log.push(ev); }
    }
    view() {
      const reps = this.reps, last = reps[reps.length - 1] || null;
      return { frame: this.frame, exercise: this.exercise, auto: this.mode === 'auto', conf: this.conf, reps: reps.length, target: this.target, last, lastEvent: this.last, cue: this.cue, cueAge: this.t - this.cueAt, done: reps.length >= this.target, partials: this.counter ? this.counter.partials : 0, recognizing: !this.exercise };
    }
    summary() {
      const r = this.reps, n = r.length || 1, sum = k => r.reduce((a, x) => a + x[k], 0);
      return { exercise: this.exercise, reps: r.length, avgTempo: r.length ? sum('ecc') / n : 0, goodRange: r.filter(x => x.range === 'GOOD').length, normalSym: r.filter(x => x.symmetry === 'NORMAL').length, partials: this.counter ? this.counter.partials : 0, fast: r.filter(x => x.tempo === 'FAST').length, bytesVideo: 0 };
    }
    end() { this.ended = true; return this.summary(); }
  }
  AI.CoachSession = CoachSession; AI.SimulatedPoseProvider = SimulatedPoseProvider; AI.TEMPO = { FAST: TEMPO_FAST, SLOW: TEMPO_SLOW };
})(typeof window !== 'undefined' ? window : globalThis);
