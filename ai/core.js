/* =====================================================================
   DDX Vision AI Engine — ядро.
   Провайдеры данных (демо и боевые адаптеры), движки (загрузка зон, трафик,
   оборудование, аномалии), оркестратор, отчёт дня и командный интерфейс управляющего.
   Без DOM: работает в браузере и в Node (тесты). Все числа считаются здесь,
   текст-пояснения только пересказывают готовые числа.
   ===================================================================== */
(function (root) {
  'use strict';
  const AI = root.DDXAI = root.DDXAI || {};
  AI.version = '5.0';

  /* ============================================================ утилиты */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const pad = n => String(n).padStart(2, '0');
  const hm = m => { m = ((Math.round(m) % 1440) + 1440) % 1440; return pad(Math.floor(m / 60)) + ':' + pad(m % 60); };
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0) / 4294967295; };
  const rng = seed => { let a = (typeof seed === 'string' ? Math.floor(hash(seed) * 4294967295) : seed) >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const plural = (n, f) => { const a = n % 10, b = n % 100; return f[a === 1 && b !== 11 ? 0 : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? 1 : 2]; };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // раздать total по весам так, чтобы сумма совпала точно (метод наибольших остатков)
  function allocate(total, w) {
    const s = w.reduce((a, b) => a + b, 0) || 1, raw = w.map(x => x / s * total), out = raw.map(Math.floor);
    let rest = total - out.reduce((a, b) => a + b, 0);
    raw.map((r, i) => [r - out[i], i]).sort((a, b) => b[0] - a[0]).slice(0, Math.max(0, rest)).forEach(([, i]) => out[i]++);
    return out;
  }
  AI.util = { clamp, lerp, pad, hm, hash, rng, plural, esc, allocate };

  /* ============================================================ уровни загрузки */
  // LOW < 45% · NORMAL 45–70% · BUSY 70–95% · CRITICAL ≥ 95%
  const TH = { normal: 0.45, busy: 0.70, critical: 0.95 };
  const LEVEL = {
    LOW: { ru: 'Свободно', c: '#03D1D6', t: '#00838A', rank: 0 },
    NORMAL: { ru: 'Норма', c: '#F2A60C', t: '#8F5600', rank: 1 },
    BUSY: { ru: 'Много людей', c: '#FD7505', t: '#B84F00', rank: 2 },
    CRITICAL: { ru: 'Критично', c: '#E5483D', t: '#C0281E', rank: 3 }
  };
  const levelOf = p => p >= TH.critical ? 'CRITICAL' : p >= TH.busy ? 'BUSY' : p >= TH.normal ? 'NORMAL' : 'LOW';
  AI.TH = TH; AI.LEVEL = LEVEL; AI.levelOf = levelOf;

  /* ============================================================ зоны клуба */
  // cap — комфортная вместимость для клуба на 130 человек (масштабируется), wait — типичная очередь на пике, мин
  const ZDEF = [
    { id: 'free', en: 'FREE WEIGHTS', ru: 'Свободные веса', types: ['rack', 'bench', 'adj', 'db'], cap: 20, wait: 10, k: 1.18, alt: ['chest', 'back', 'legs'] },
    { id: 'legs', en: 'LEGS', ru: 'Ноги', types: ['legpress', 'legext', 'legcurl', 'glute', 'smith'], cap: 8, wait: 8, k: 1.0, alt: ['free', 'func'] },
    { id: 'chest', en: 'CHEST', ru: 'Грудь', types: ['chest', 'fly', 'cross', 'shoulder'], cap: 7, wait: 7, k: 0.98, alt: ['free', 'func'] },
    { id: 'back', en: 'BACK', ru: 'Спина', types: ['lat', 'srow', 'grav', 'hyper'], cap: 7, wait: 7, k: 0.95, alt: ['free', 'func'] },
    { id: 'cardio', en: 'CARDIO', ru: 'Кардио', types: ['tread', 'bike', 'ellip', 'row', 'climb'], cap: 22, wait: 5, k: 1.05, alt: ['func', 'stretch'] },
    { id: 'func', en: 'FUNCTIONAL', ru: 'Функционал', types: ['plat', 'trx'], cap: 14, wait: 6, k: 0.84, alt: ['free', 'cardio'] },
    { id: 'stretch', en: 'STRETCHING', ru: 'Растяжка', types: [], cap: 10, wait: 0, k: 0.55, alt: ['group'] },
    { id: 'group', en: 'GROUP TRAINING', ru: 'Групповые', types: [], cap: 22, wait: 0, k: 0, alt: ['stretch'] },
    { id: 'locker', en: 'LOCKER AREA', ru: 'Раздевалки', types: [], cap: 30, wait: 0, k: 0.7, alt: [] },
    { id: 'entrance', en: 'ENTRANCE', ru: 'Вход', types: [], cap: 12, wait: 0, k: 0.5, alt: [] }
  ];
  const ZBY = {}; ZDEF.forEach(z => { ZBY[z.id] = z; });
  const ZOF = {}; ZDEF.forEach(z => z.types.forEach(t => { ZOF[t] = z.id; }));
  AI.ZDEF = ZDEF; AI.ZBY = ZBY; AI.ZOF = ZOF;
  // ожидание тренажёра из-за очереди (мин) по загрузке зоны
  const waitMin = (p, base) => p < 0.7 || !base ? 0 : base * Math.pow(clamp((p - 0.7) / 0.3, 0, 1), 1.3);
  AI.waitMin = waitMin;

  /* ============================================================ статусы оборудования */
  const EQST = {
    AVAILABLE: { ru: 'Свободен', c: '#0FA866' },
    IN_USE: { ru: 'Занят', c: '#E5483D' },
    QUEUE: { ru: 'Очередь', c: '#FD7505' },
    OFFLINE: { ru: 'Нет связи', c: '#7A8A8C' },
    MAINTENANCE: { ru: 'Обслуживание', c: '#9AA8AA' },
    UNKNOWN: { ru: 'Нет данных', c: '#AD58ED' }
  };
  AI.EQST = EQST;

  /* ============================================================ шина событий */
  class Bus {
    constructor() { this.h = {}; }
    on(t, f) { (this.h[t] = this.h[t] || []).push(f); return () => { this.h[t] = (this.h[t] || []).filter(x => x !== f); }; }
    emit(t, p) { [].concat(this.h[t] || [], this.h['*'] || []).forEach(f => { try { f(p, t); } catch (e) { /* подписчик не должен ронять шину */ } }); }
  }
  AI.bus = new Bus();

  /* ============================================================ приватность и аудит */
  // PROCESS VIDEO — STORE DATA: видео не хранится, наружу уходят только метаданные
  const privacy = {
    role: 'member', // member | coach | manager
    retention: { analyticsDays: 90, keypointsDays: 30, sessionDays: 365, videoDays: 0 },
    consent: { coach: false, sources: { inbody: true, workouts: true, coach: true, recovery: false } },
    cameraZones: { free: true, legs: true, chest: true, back: true, cardio: true, func: true, stretch: true, entrance: true, group: false, locker: false },
    audit: [],
    ROLES: { member: 'Посетитель', coach: 'Тренер', manager: 'Управляющий' },
    can(action, zone) {
      const r = this.role;
      if (action === 'command') return r === 'manager';
      if (action === 'camera') return (r === 'manager' || r === 'coach') && (!zone || !!this.cameraZones[zone]);
      if (action === 'retention') return r === 'manager';
      return true;
    },
    setRole(r) { if (!this.ROLES[r] || r === this.role) return; const prev = this.role; this.role = r; this.log('role.change', prev + ' → ' + r + ' (демо, без входа)'); },
    log(action, detail) {
      const rec = { id: (this.audit[0] ? this.audit[0].id : 0) + 1, ts: Date.now(), role: this.role, action, detail: String(detail || '') };
      this.audit.unshift(rec); if (this.audit.length > 120) this.audit.length = 120;
      AI.bus.emit('audit', rec); return rec;
    },
    export() { return { retention: this.retention, consent: this.consent, role: this.role }; },
    import(o) { if (!o) return; if (o.retention) Object.assign(this.retention, o.retention); if (o.consent) { this.consent.coach = !!o.consent.coach; Object.assign(this.consent.sources, o.consent.sources || {}); } }
  };
  AI.privacy = privacy;

  /* ============================================================ источник данных исходного приложения */
  // SimSource — всё, что демо-провайдерам нужно от DDX Vision (в тестах подставляется заглушка)
  AI.makeSim = function (B) {
    return {
      now: () => B.now(),
      realNow: () => B.mskNow(),
      loadAt: (dow, min) => B.loadAt(dow, min),
      curLoad: () => B.curLoad(),
      people: () => B.state.people,
      clubCap: () => B.state.club.cap,
      clubId: () => B.state.club.id,
      clubName: () => B.state.club.name,
      eq: () => B.state.eq,
      eqState: id => { const s = B.state.ss[id] || {}; return { st: B.stOf(id), left: s.left || 0, since: s.since || 0, sets: s.sets || 0, total: s.total || 0, used: s.used || 0, util: s.util || 0, reserved: !!s.res }; },
      type: t => B.T[t],
      trend: () => B.predict().trend,
      studioAt(min) {
        const n = B.now(), c = B.CLASSES.find(x => x[0] <= min && min < x[0] + x[3]);
        return c ? clamp((clamp(B.loadAt(n.dow, c[0]) * 24 + 3, 6, 22)) / 22, 0.2, 1) : 0.05;
      },
      markUnavailable(ids) { ids.forEach(id => { if (B.state.ss[id]) B.state.ss[id] = { s: 'service', left: 0, since: 0, sets: 0, total: 0, used: 0, util: 0 }; }); }
    };
  };

  /* ============================================================ провайдеры */
  class Provider {
    constructor(kind) { this.kind = kind; this.mode = 'DEMO'; this._st = { state: 'ok', message: '', at: 0 }; }
    status() { return this._st; }
    start() { } stop() { }
  }
  class CameraProvider extends Provider { constructor() { super('camera'); } getFrame() { throw new Error('CameraProvider.getFrame не реализован'); } }
  class EquipmentProvider extends Provider { constructor() { super('equipment'); } getFrame() { throw new Error('EquipmentProvider.getFrame не реализован'); } }
  class IdentityProvider extends Provider { constructor() { super('identity'); } }
  class BodyCompositionProvider extends Provider { constructor() { super('body'); } }
  class WorkoutProvider extends Provider { constructor() { super('workout'); } }
  class PoseProvider extends Provider { constructor() { super('pose'); } }
  AI.providers = { Provider, CameraProvider, EquipmentProvider, IdentityProvider, BodyCompositionProvider, WorkoutProvider, PoseProvider };

  /* ---------- демо: камеры (обезличенные счётчики зон из симуляции клуба) ---------- */
  class DemoCameraProvider extends CameraProvider {
    constructor(sim, scen) { super(); this.sim = sim; this.scen = scen; }
    zoneP(z, now) {
      const sim = this.sim, L = sim.curLoad();
      if (z.types.length) {
        let busy = 0, tot = 0;
        sim.eq().forEach(e => {
          if (z.types.indexOf(e.t) < 0) return;
          const ti = sim.type(e.t), s = sim.eqState(e.id);
          if (ti.cap) { busy += s.used; tot += ti.cap; } else if (s.st !== 'service') { tot++; if (s.st === 'busy' || s.st === 'soon') busy++; }
        });
        let p = tot ? busy / tot : 0;
        if (z.id === 'func') p = clamp(p * 0.5 + clamp(L * 0.8 + 0.05, 0, 1) * 0.5, 0, 1);
        return p;
      }
      if (z.id === 'group') return sim.studioAt(now.min);
      if (z.id === 'stretch') return clamp(0.1 + 0.46 * L + Math.sin(now.min / 9) * 0.05, 0, 0.95);
      if (z.id === 'locker') return clamp(0.12 + 0.62 * L, 0, 0.95);
      return clamp(0.08 + 0.2 * L + Math.max(0, sim.trend()) * 2.2, 0, 0.95); // вход
    }
    dwell(z) {
      const sim = this.sim;
      if (z.types.length) {
        let sum = 0, n = 0, dm = 0, dn = 0;
        sim.eq().forEach(e => { if (z.types.indexOf(e.t) < 0) return; const ti = sim.type(e.t), s = sim.eqState(e.id); if (ti.cap) return; dm += (ti.d[0] + ti.d[1]) / 2; dn++; if (s.st === 'busy' || s.st === 'soon') { sum += s.since + s.left; n++; } });
        return n ? sum / n : dn ? dm / dn : 10;
      }
      return { stretch: 12, group: 50, locker: 9, entrance: 1.5 }[z.id] || 10;
    }
    getFrame() {
      const sim = this.sim, now = sim.now(), sc = this.scen && this.scen.active ? this.scen : null;
      const clubCap = sc ? sc.clubCap : sim.clubCap(), scale = clubCap / 130;
      const zones = ZDEF.map(z => ({ id: z.id, p: sc ? sc.zoneP(z.id) : this.zoneP(z, now), capacity: Math.max(2, Math.round(z.cap * scale)), dwellMin: sc && sc.dwell(z.id) != null ? sc.dwell(z.id) : this.dwell(z), count: 0 }));
      const people = sc ? sc.people() : Math.round(sim.people());
      const cnt = allocate(people, zones.map(z => z.p * z.capacity + 0.05));
      zones.forEach((z, i) => { z.count = cnt[i]; });
      const byId = {}; zones.forEach(z => { byId[z.id] = z; });
      const FLOW = [['entrance', 'locker', 0.55], ['locker', 'cardio', 0.18], ['locker', 'free', 0.13], ['free', 'chest', 0.09], ['chest', 'back', 0.07], ['back', 'legs', 0.06], ['legs', 'cardio', 0.07], ['cardio', 'stretch', 0.08], ['stretch', 'locker', 0.06], ['group', 'locker', 0.5]];
      const flows = FLOW.map(([a, b, w]) => ({ from: a, to: b, per10: Math.round(byId[a].count * w * (0.8 + 0.4 * hash(a + b + Math.floor(now.min / 5)))) })).filter(f => f.per10 > 0).sort((x, y) => y.per10 - x.per10);
      const dL = sim.loadAt(now.dow, Math.min(now.min + 10, 1439)) - sim.loadAt(now.dow, now.min), base = people * 0.055, swing = Math.abs(dL) * clubCap * 0.9;
      const entrance = { in10: Math.round(base + (dL > 0 ? swing : 0)), out10: Math.round(base + (dL < 0 ? swing : 0)) };
      return { ts: Date.now(), simMin: now.min, dow: now.dow, clubId: sim.clubId(), clubName: sim.clubName(), clubCap, people, zones, flows, entrance, source: 'demo' };
    }
  }

  /* ---------- демо: оборудование ---------- */
  // OFFLINE — нет связи с датчиком, UNKNOWN — камера не видит станцию уверенно
  const DEMO_OVERLAY = { ellip2: 'OFFLINE', adj3: 'UNKNOWN' };
  class DemoEquipmentProvider extends EquipmentProvider {
    constructor(sim, scen) { super(); this.sim = sim; this.scen = scen; this.overlay = DEMO_OVERLAY; }
    ids(status) { return Object.keys(this.overlay).filter(k => this.overlay[k] === status); }
    getFrame(frame) {
      const sim = this.sim, zp = {}; frame.zones.forEach(z => { zp[z.id] = z.p; });
      const ov = this.scen && this.scen.active ? this.scen.eqOverlay : null;
      const items = sim.eq().map(e => {
        const ti = sim.type(e.t), s = sim.eqState(e.id), zone = ZOF[e.t];
        let status = 'AVAILABLE', eta = 0, queue = 0;
        const o = ov && ov[e.id];
        if (o) { status = o.status; eta = o.eta || 0; queue = o.queue || 0; }
        else if (this.overlay[e.id]) status = this.overlay[e.id];
        else if (s.st === 'service') status = 'MAINTENANCE';
        else if (ti.cap) { status = s.used >= ti.cap ? 'IN_USE' : 'AVAILABLE'; eta = status === 'IN_USE' ? 3 : 0; }
        else if (s.st === 'free') status = 'AVAILABLE';
        else {
          const pz = zp[zone] || 0, h = hash(e.id + ':' + Math.floor(frame.simMin / 5));
          queue = pz >= 0.78 && h < (pz - 0.7) * 1.1 ? (h < (pz - 0.9) * 1.1 ? 2 : 1) : 0;
          eta = Math.min(15, Math.max(1, Math.ceil(s.left))) + queue * 2;
          status = queue ? 'QUEUE' : 'IN_USE';
        }
        return { id: e.id, type: e.t, n: e.n, name: ti.n, brand: ti.b, zone, status, etaMin: eta, queue, since: s.st === 'busy' || s.st === 'soon' ? s.since : 0, maxTypical: ti.d[1], slots: ti.cap ? { used: s.used, cap: ti.cap } : null, x: e.x, y: e.y };
      });
      return { ts: Date.now(), items, source: 'demo' };
    }
  }

  /* ---------- боевые адаптеры (HTTP) — контракт описан в docs/AI-ENGINE.md ---------- */
  class HttpClient {
    constructor(cfg) { this.base = String(cfg.baseUrl || '').replace(/\/+$/, ''); this.token = cfg.token || ''; this.timeout = cfg.timeoutMs || 6000; }
    async get(path) {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, t = ctl ? setTimeout(() => ctl.abort(), this.timeout) : 0;
      try {
        const r = await fetch(this.base + path, { headers: this.token ? { Authorization: 'Bearer ' + this.token } : {}, signal: ctl ? ctl.signal : undefined, cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } finally { if (t) clearTimeout(t); }
    }
  }
  class HttpCameraProvider extends CameraProvider {
    constructor(cfg) { super(); this.mode = 'LIVE'; this.http = new HttpClient(cfg); this.frame = null; this._st = { state: 'connecting', message: '', at: 0 }; this.poll = cfg.pollMs || 2000; }
    async fetchOnce() {
      try {
        const j = await this.http.get('/v1/occupancy');
        const zones = ZDEF.map(d => { const z = (j.zones || []).find(x => x.id === d.id); if (!z) return null; const capacity = Math.max(1, +z.capacity || d.cap); return { id: d.id, count: +z.count || 0, capacity, p: clamp(z.p != null ? +z.p : (+z.count || 0) / capacity, 0, 1), dwellMin: +z.dwellMin || 0 }; }).filter(Boolean);
        if (!zones.length) throw new Error('пустой ответ /v1/occupancy');
        const people = j.people != null ? +j.people : zones.reduce((a, z) => a + z.count, 0);
        this.frame = { ts: Date.now(), clubId: j.clubId || '', clubName: j.clubName || '', clubCap: +j.clubCap || zones.reduce((a, z) => a + z.capacity, 0), people, zones, flows: j.flows || [], entrance: j.entrance || { in10: 0, out10: 0 }, source: 'live' };
        this._st = { state: 'ok', message: '', at: Date.now() };
      } catch (e) { this._st = { state: 'error', message: String(e && e.message || e), at: Date.now() }; }
    }
    start() { this.fetchOnce(); this.timer = setInterval(() => this.fetchOnce(), this.poll); }
    stop() { clearInterval(this.timer); }
    getFrame() {
      if (!this.frame) return null;
      const now = { dow: 0, min: 0 }; // дополняется оркестратором
      const f = Object.assign({}, this.frame); f.simMin = now.min; f.stale = Date.now() - this._st.at > this.poll * 5; return f;
    }
  }
  class HttpEquipmentProvider extends EquipmentProvider {
    constructor(cfg) { super(); this.mode = 'LIVE'; this.http = new HttpClient(cfg); this.frame = null; this._st = { state: 'connecting', message: '', at: 0 }; this.poll = cfg.pollMs || 3000; }
    async fetchOnce() {
      try {
        const j = await this.http.get('/v1/equipment');
        const items = (j.items || []).map(it => ({ id: String(it.id), type: it.type || '', n: it.n || 0, name: it.name || it.type || '', brand: it.brand || '', zone: ZOF[it.type] || it.zone || '', status: EQST[it.status] ? it.status : 'UNKNOWN', etaMin: +it.etaMin || 0, queue: +it.queue || 0, since: +it.since || 0, maxTypical: +it.maxTypical || 0, slots: it.slots || null, x: +it.x || 0, y: +it.y || 0 }));
        this.frame = { ts: Date.now(), items, source: 'live' }; this._st = { state: 'ok', message: '', at: Date.now() };
      } catch (e) { this._st = { state: 'error', message: String(e && e.message || e), at: Date.now() }; }
    }
    start() { this.fetchOnce(); this.timer = setInterval(() => this.fetchOnce(), this.poll); }
    stop() { clearInterval(this.timer); }
    getFrame() { return this.frame; }
  }
  class HttpIdentityProvider extends IdentityProvider {
    constructor(cfg) { super(); this.mode = 'LIVE'; this.http = new HttpClient(cfg); }
    async resolve(token) { return this.http.get('/v1/sessions/resolve?token=' + encodeURIComponent(token)); }
  }
  class HttpBodyCompositionProvider extends BodyCompositionProvider {
    constructor(cfg) { super(); this.mode = 'LIVE'; this.http = new HttpClient(cfg); }
    async series(ref) { return this.http.get('/v1/members/' + encodeURIComponent(ref) + '/body-composition'); }
  }
  class HttpWorkoutProvider extends WorkoutProvider {
    constructor(cfg) { super(); this.mode = 'LIVE'; this.http = new HttpClient(cfg); }
    async history(ref, days) { return this.http.get('/v1/members/' + encodeURIComponent(ref) + '/workouts?days=' + (days || 120)); }
  }
  AI.providers.Demo = { DemoCameraProvider, DemoEquipmentProvider };
  AI.providers.Http = { HttpClient, HttpCameraProvider, HttpEquipmentProvider, HttpIdentityProvider, HttpBodyCompositionProvider, HttpWorkoutProvider };

  /* ============================================================ OCCUPANCY ENGINE */
  const FK = { cardio: 0.7, free: 1.15, legs: 1.05, chest: 1.1, back: 1.0, func: 0.9, stretch: 0.6, group: 0, locker: 0.5, entrance: 0.8 };
  // прогноз загрузки зоны через dMin минут: текущая загрузка × изменение типового дня
  function forecastP(z, p, now, sim, dMin) {
    if (z.id === 'group') return sim.studioAt(now.min + dMin);
    const Ln = sim.loadAt(now.dow, now.min), Lf = sim.loadAt(now.dow, Math.min(now.min + dMin, 1439));
    const ratio = clamp((Lf + 0.06) / (Ln + 0.06), 0.55, 1.75);
    const d = p * (ratio - 1) * (FK[z.id] == null ? 1 : FK[z.id]); // изменение загрузки по типовому дню
    return clamp(p + (d > 0 && p > 0.9 ? d * 0.4 : d), 0, 1); // у потолка рост замедляется
  }
  function occupancy(frame, sim, now, scen) {
    return frame.zones.map(f => {
      const d = ZBY[f.id];
      let p15 = forecastP(d, f.p, now, sim, 15), p30 = forecastP(d, f.p, now, sim, 30);
      if (scen && scen.active && scen.forecast) { const o = scen.forecast(f.id, f.p); if (o) { p15 = o[0]; p30 = o[1]; } }
      return { id: f.id, en: d.en, ru: d.ru, count: f.count, capacity: f.capacity, p: f.p, level: levelOf(f.p), dwell: f.dwellMin, p15, p30, level15: levelOf(p15), level30: levelOf(p30), trend: p15 - f.p > 0.02 ? 'up' : p15 - f.p < -0.02 ? 'down' : 'flat', wait: waitMin(f.p, d.wait), wait15: waitMin(p15, d.wait), hasEq: d.types.length > 0 };
    });
  }
  AI.occupancy = occupancy; AI.forecastP = forecastP;

  /* ============================================================ TRAFFIC ENGINE */
  function criticalIn(z) {
    if (z.p >= TH.critical) return 0;
    if (z.p15 >= TH.critical) return Math.round(15 * (TH.critical - z.p) / Math.max(z.p15 - z.p, 1e-6));
    if (z.p30 >= TH.critical) return Math.round(15 + 15 * (TH.critical - z.p15) / Math.max(z.p30 - z.p15, 1e-6));
    return null;
  }
  const REDIR = { 'free>chest': 'Жимовые упражнения — на тренажёры груди', 'free>legs': 'Приседания — на тренажёры ног (жим, разгибания)', 'free>back': 'Тяги — на блоки и гравитрон', 'chest>free': 'Жимы — на свободные веса', 'legs>func': 'Часть нагрузки на ноги — в функциональную зону' };
  function trafficEngine(zones, auto) {
    const byId = {}; zones.forEach(z => { byId[z.id] = z; });
    const preds = zones.map(z => ({ id: z.id, now: z.p, p15: z.p15, p30: z.p30, level: z.level, level15: z.level15, criticalIn: criticalIn(z) }));
    const recs = [];
    zones.filter(z => z.hasEq && Math.max(z.p, z.p15) >= 0.85).sort((a, b) => b.p15 - a.p15).forEach(z => {
      const d = ZBY[z.id];
      const alt = d.alt.map(id => byId[id]).filter(a => a && a.hasEq && a.p15 <= 0.62).sort((a, b) => a.p15 - b.p15)[0];
      if (!alt) return;
      const shift = clamp(z.p15 - 0.78, 0.04, 0.2);
      const toAfter = clamp(alt.p15 + shift * (z.capacity / Math.max(alt.capacity, 1)), 0, 0.99);
      const w0 = waitMin(z.p15, d.wait), w1 = waitMin(z.p15 - shift, d.wait);
      recs.push({ from: z.id, to: alt.id, shift, fromAfter: z.p15 - shift, toAfter, waitBefore: w0, waitAfter: w1, savedMin: Math.max(0, w0 - w1), text: REDIR[z.id + '>' + alt.id] || ('Часть тренирующихся из «' + z.ru + '» — в «' + alt.ru + '»'), spare: Math.max(0, alt.capacity - alt.count) });
    });
    const crit = preds.filter(p => p.criticalIn != null).sort((a, b) => a.criticalIn - b.criticalIn);
    return { predictions: preds, recs, nextCritical: crit[0] ? { zone: crit[0].id, inMin: crit[0].criticalIn } : null, auto: !!auto };
  }
  AI.trafficEngine = trafficEngine; AI.criticalIn = criticalIn;

  /* ============================================================ EQUIPMENT ENGINE */
  function equipmentEngine(frame) {
    const items = (frame && frame.items) || [], counts = { AVAILABLE: 0, IN_USE: 0, QUEUE: 0, OFFLINE: 0, MAINTENANCE: 0, UNKNOWN: 0 };
    items.forEach(i => { counts[i.status] = (counts[i.status] || 0) + 1; });
    const alerts = [];
    items.forEach(i => {
      if (i.status === 'OFFLINE') alerts.push({ eq: i.id, kind: 'offline', title: i.name + ' №' + i.n + ' — нет связи', detail: 'Датчик не отвечает. Статус неизвестен, из маршрутов исключён.' });
      else if (i.status === 'MAINTENANCE') alerts.push({ eq: i.id, kind: 'maintenance', title: i.name + ' №' + i.n + ' на обслуживании', detail: 'Исключён из маршрутов посетителей.' });
      else if ((i.status === 'IN_USE' || i.status === 'QUEUE') && i.maxTypical && i.since > i.maxTypical * 1.8) alerts.push({ eq: i.id, kind: 'long', title: i.name + ' №' + i.n + ' — статус «занят» держится ' + Math.round(i.since) + ' мин', detail: 'Обычно до ' + i.maxTypical + ' мин. Стоит проверить на месте.' });
    });
    return { items, counts, alerts, total: items.length };
  }
  AI.equipmentEngine = equipmentEngine;

  /* ============================================================ DAY MODEL (отчёт дня) */
  // «модель дня»: типовая кривая загрузки × коэффициенты зон. Для отчёта и для прошлых событий.
  function dayModel(sim, dow, upToMin, clubCap) {
    const t = [], people = [], load = [], zp = {};
    ZDEF.forEach(z => { zp[z.id] = []; });
    const end = clamp(Math.floor(upToMin), 360, 1380);
    for (let m = 360; m <= end; m += 1) {
      const L = sim.loadAt(dow, m), ppl = Math.round(L * clubCap); t.push(m); load.push(L); people.push(ppl);
      ZDEF.forEach(z => {
        let p;
        if (z.id === 'group') p = sim.classAt ? sim.classAt(dow, m) : 0.05;
        else if (z.id === 'stretch') p = clamp(0.1 + 0.46 * L, 0, 0.95);
        else if (z.id === 'entrance') p = clamp(0.08 + 0.2 * L, 0, 0.95);
        else p = clamp(L * z.k, 0, 0.99);
        zp[z.id].push(p);
      });
    }
    return { t, people, load, zp, clubCap };
  }
  // участки, где значение держится выше thr (гистерезис 5 п.п., чтобы шум не дробил участок)
  function intervals(arr, t, thr, minLen) {
    const res = [], off = thr - 0.05; let s = -1;
    const close = i => { if (t[i] - t[s] >= minLen) res.push({ from: t[s], to: t[i], dur: t[i] - t[s] }); s = -1; };
    for (let i = 0; i < arr.length; i++) { if (s < 0) { if (arr[i] >= thr) s = i; } else if (arr[i] < off) close(i - 1); }
    if (s >= 0) close(arr.length - 1);
    return res;
  }
  // события «за сегодня» по модели дня: длительная высокая загрузка зон
  function modeledEvents(dm) {
    const ev = [];
    ZDEF.filter(z => z.types.length).forEach(z => {
      intervals(dm.zp[z.id], dm.t, 0.9, 10).forEach(iv => ev.push({ id: 'm-' + z.id + '-' + iv.from, type: 'congestion', zone: z.id, sev: 'watch', title: z.ru + ': нетипично высокая загрузка', startMin: iv.from, dur: iv.dur, active: false, modeled: true }));
    });
    return ev.sort((a, b) => a.startMin - b.startMin);
  }

  /* ============================================================ ANOMALY ENGINE */
  // Только операционные сигналы по зонам и оборудованию. Никаких выводов о людях и их намерениях.
  class AnomalyEngine {
    constructor() { this.active = new Map(); this.pending = new Map(); this.history = []; this.seq = 0; this.peopleHist = []; }
    open(key, ev) {
      if (this.active.has(key)) { Object.assign(this.active.get(key), { detail: ev.detail, dur: ev.dur != null ? ev.dur : this.active.get(key).dur }); return; }
      const e = Object.assign({ id: 'e' + (++this.seq), key, active: true, ack: false }, ev); this.active.set(key, e); this.history.push(e); if (this.history.length > 200) this.history.shift(); AI.bus.emit('event', e);
    }
    close(key) { const e = this.active.get(key); if (e) { e.active = false; e.resolved = true; this.active.delete(key); } }
    ack(id) { const e = this.history.find(x => x.id === id); if (e) e.ack = true; return e; }
    evaluate(zones, eq, clock, dtSim, extra) {
      const seen = new Set();
      zones.filter(z => z.hasEq).forEach(z => {
        const key = 'cong:' + z.id;
        if (z.p >= 0.88 && z.p15 >= z.p - 0.02) {
          // длительность нарастает по «минутам симуляции»; если застали перегрузку при запуске — считаем, что она уже идёт несколько минут
          const run = (this.pending.has(key) ? this.pending.get(key) : 3 + Math.floor(hash(key + clock.dow) * 7)) + dtSim;
          this.pending.set(key, run);
          if (run >= 4) {
            seen.add(key);
            this.open(key, { type: 'congestion', zone: z.id, sev: z.p >= TH.critical ? 'action' : 'watch', title: z.ru + ': нетипично высокая загрузка', detail: 'Загрузка ' + Math.round(z.p * 100) + '%, прогноз +15 мин — ' + Math.round(z.p15 * 100) + '%.', dur: run, startMin: clock.min - run });
            this.active.get(key).dur = run;
          }
        } else this.pending.delete(key);
      });
      eq.alerts.filter(a => a.kind === 'long').forEach(a => {
        const key = 'long:' + a.eq; seen.add(key);
        const it = eq.items.find(i => i.id === a.eq);
        this.open(key, { type: 'equipment', zone: it.zone, eq: it.id, sev: 'watch', title: a.title, detail: a.detail, dur: it.since, startMin: clock.min - it.since });
        const e = this.active.get(key); if (e) e.dur = it.since;
      });
      // зона без посетителей при загруженном клубе: возможно, закрыта или недоступна (сигнал сотруднику, а не вывод о людях)
      zones.filter(z => z.id !== 'entrance').forEach(z => {
        const key = 'closed:' + z.id, pk = 'c:' + z.id;
        if (extra.load >= 0.5 && z.p < 0.03 && z.p15 < 0.05 && !(extra.closed || []).includes(z.id)) {
          const run = (this.pending.has(pk) ? this.pending.get(pk) : 0) + dtSim; this.pending.set(pk, run);
          if (run >= 3) { seen.add(key); this.open(key, { type: 'zone', zone: z.id, sev: 'watch', title: z.ru + ': зона пустует при загруженном клубе', detail: 'Возможно, зона закрыта или станции недоступны. Стоит проверить на месте.', dur: run, startMin: clock.min - run }); this.active.get(key).dur = run; }
        } else this.pending.delete(pk);
      });
      // очереди: одно событие на зону (кардио не считаем), чтобы не шуметь по каждой станции
      const qz = {};
      eq.items.filter(i => i.status === 'QUEUE' && i.zone !== 'cardio' && ZBY[i.zone]).forEach(i => { const q = qz[i.zone] || (qz[i.zone] = { n: 0, max: 0 }); q.n++; if (i.etaMin > q.max) q.max = i.etaMin; });
      [...this.pending.keys()].filter(k => k.indexOf('q:') === 0 && !qz[k.slice(2)]).forEach(k => this.pending.delete(k));
      Object.keys(qz).forEach(zid => {
        const q = qz[zid], pk = 'q:' + zid;
        if (q.max < 8) { this.pending.delete(pk); return; }
        const run = (this.pending.has(pk) ? this.pending.get(pk) : 2) + dtSim, key = 'queue:' + zid; this.pending.set(pk, run); seen.add(key);
        this.open(key, { type: 'queue', zone: zid, sev: 'watch', title: 'Очередь у тренажёров: ' + ZBY[zid].ru, detail: 'Ожидание до ' + q.max + ' мин, станций с очередью — ' + q.n + '.', dur: run, startMin: clock.min - run });
        this.active.get(key).dur = run;
      });
      eq.items.filter(i => i.status === 'OFFLINE').forEach(i => {
        const key = 'off:' + i.id; seen.add(key);
        this.open(key, { type: 'equipment', zone: i.zone, eq: i.id, sev: 'info', title: i.name + ' №' + i.n + ': нет связи', detail: 'Датчик оборудования не отвечает.', dur: 0, startMin: clock.min });
      });
      // резкое изменение числа людей
      this.peopleHist.push(extra.people); if (this.peopleHist.length > 7) this.peopleHist.shift();
      const jump = this.peopleHist.length >= 6 ? this.peopleHist[this.peopleHist.length - 1] - this.peopleHist[0] : 0, thr = Math.max(6, extra.clubCap * 0.06);
      if (Math.abs(jump) >= thr) { seen.add('jump'); this.open('jump', { type: 'occupancy', zone: 'entrance', sev: 'info', title: 'Резкое изменение: ' + (jump > 0 ? '+' : '') + jump + ' чел. за несколько минут', detail: 'Возможно, закончилась или началась групповая тренировка.', dur: 0, startMin: clock.min }); }
      // закрыть всё, что больше не подтверждается
      [...this.active.keys()].forEach(k => { if (!seen.has(k)) this.close(k); });
      return [...this.active.values()];
    }
  }
  AI.AnomalyEngine = AnomalyEngine;

  /* ============================================================ ОТЧЁТ ДНЯ */
  function dailyReport(snap, sim) {
    const now = snap.clock, dm = dayModel(sim, now.dow, now.min, snap.clubCap);
    let pk = 0, pi = 0; dm.people.forEach((v, i) => { if (v > pk) { pk = v; pi = i; } });
    const busyIdx = dm.load.map((l, i) => l >= 0.5 ? i : -1).filter(i => i >= 0);
    const zs = ZDEF.filter(z => z.types.length).map(z => { const a = busyIdx.length ? busyIdx.map(i => dm.zp[z.id][i]) : dm.zp[z.id]; return { id: z.id, avg: a.reduce((s, v) => s + v, 0) / Math.max(a.length, 1) }; }).sort((a, b) => b.avg - a.avg);
    const wAll = dm.t.map((m, i) => { const ws = ZDEF.filter(z => z.types.length).map(z => waitMin(dm.zp[z.id][i], z.wait)); return ws.reduce((s, v) => s + v, 0) / ws.length; });
    const avgWait = busyIdx.length ? busyIdx.reduce((s, i) => s + wAll[i], 0) / busyIdx.length : 0;
    const past = modeledEvents(dm), live = snap.events.filter(e => e.active);
    const liveZones = new Set(live.map(e => e.zone));
    const events = past.filter(e => !(liveZones.has(e.zone) && e.startMin + e.dur >= now.min - 2)).concat(live.map(e => ({ id: e.id, type: e.type, zone: e.zone, title: e.title, startMin: e.startMin, dur: e.dur, active: true })));
    const eqAlerts = snap.eq.alerts.length;
    const top = zs[0] || { id: 'free', avg: 0 };
    const f = { upTo: now.min, peakPct: Math.round(pk / Math.max(snap.clubCap, 1) * 100), peakPeople: pk, peakTime: dm.t[pi] || now.min, topZone: top.id, topZonePct: Math.round(top.avg * 100), avgWait: Math.round(avgWait * 10) / 10, eqAlerts, aiEvents: events.length, ongoing: now.min < 22 * 60 };
    const zr = ZBY[f.topZone].ru;
    const summary = 'К ' + hm(f.upTo) + ' пик нагрузки был в ' + hm(f.peakTime) + ': в клубе находилось ' + f.peakPeople + ' ' + plural(f.peakPeople, ['человек', 'человека', 'человек']) + ' (' + f.peakPct + '% вместимости). '
      + 'Самая загруженная зона — «' + zr + '» (в среднем ' + f.topZonePct + '% в часы пик), среднее ожидание тренажёра — ' + String(f.avgWait).replace('.', ',') + ' мин. '
      + 'Зафиксировано ' + f.aiEvents + ' ' + plural(f.aiEvents, ['операционное событие', 'операционных события', 'операционных событий']) + ' и ' + f.eqAlerts + ' ' + plural(f.eqAlerts, ['оповещение', 'оповещения', 'оповещений']) + ' по оборудованию. '
      + (f.topZonePct >= 80 ? 'Рекомендация: направлять часть потока из «' + zr + '» на тренажёры в часы пика.' : 'Критичных перегрузок не было.');
    return { facts: f, summary, events, modeled: true };
  }
  AI.dailyReport = dailyReport; AI.dayModel = dayModel;

  /* ============================================================ ОРКЕСТРАТОР */
  class Orchestrator {
    constructor(sim) {
      this.sim = sim; this.mode = 'DEMO'; this.scen = null; this.anom = new AnomalyEngine(); this.snap = null; this.simClock = 0;
      this.auto = false; this.autoAt = 0; this.listeners = []; this.series = []; this.closedZones = []; // зоны, закрытые планово: по ним сигнала нет
      this.setDemo();
    }
    setDemo() {
      this.stopLive(); this.mode = 'DEMO';
      const scen = this.scen;
      this.providers = { camera: new DemoCameraProvider(this.sim, scen), equipment: new DemoEquipmentProvider(this.sim, scen) };
      AI.bus.emit('mode', 'DEMO');
    }
    attachScenario(scen) { this.scen = scen; if (this.mode === 'DEMO') { this.providers.camera.scen = scen; this.providers.equipment.scen = scen; } }
    async connectLive(cfg) {
      const cam = new HttpCameraProvider(cfg), eq = new HttpEquipmentProvider(cfg);
      await cam.fetchOnce(); await eq.fetchOnce();
      if (cam.status().state !== 'ok') throw new Error('Камеры: ' + cam.status().message);
      cam.start(); eq.start(); this.stopLive();
      this.providers = { camera: cam, equipment: eq }; this.mode = 'LIVE'; this.liveCfg = { baseUrl: cfg.baseUrl };
      AI.bus.emit('mode', 'LIVE'); return cam.status();
    }
    stopLive() { if (this.providers && this.mode === 'LIVE') { this.providers.camera.stop(); this.providers.equipment.stop(); } }
    subscribe(f) { this.listeners.push(f); return () => { this.listeners = this.listeners.filter(x => x !== f); }; }
    setAuto(on) { this.auto = !!on; this.autoAt = this.simClock; privacy.log('traffic.auto', on ? 'включено перераспределение потока' : 'выключено'); }
    update(dtSim) {
      const sim = this.sim, live = this.mode === 'LIVE', now = live && sim.realNow ? sim.realNow() : sim.now();
      this.simClock += dtSim == null ? 0.16 : dtSim;
      let frame = this.providers.camera.getFrame();
      if (!frame) { this.snap = { empty: true, mode: this.mode, clock: now, error: this.providers.camera.status().message, ts: Date.now() }; this.listeners.forEach(f => f(this.snap)); return this.snap; }
      if (live) { frame.simMin = now.min; frame.dow = now.dow; }
      let zones = occupancy(frame, sim, now, this.scen);
      // перераспределение потока: эффект нарастает ~3 «минуты симуляции»
      let tr = trafficEngine(zones, this.auto), steerK = 0;
      if (this.auto && tr.recs.length) {
        steerK = clamp((this.simClock - this.autoAt) / 3, 0, 1);
        const byId = {}; zones.forEach(z => { byId[z.id] = z; });
        const raw = tr.recs;
        raw.forEach(r => { const a = byId[r.from], b = byId[r.to]; const d = r.shift * steerK; a.p15 = clamp(a.p15 - d, 0, 0.99); a.p30 = clamp(a.p30 - d, 0, 0.99); a.p = clamp(a.p - d * 0.6, 0, 0.99); b.p15 = clamp(b.p15 + (r.toAfter - (b.p15)) * steerK, 0, 0.99); a.level = levelOf(a.p); a.level15 = levelOf(a.p15); b.level15 = levelOf(b.p15); a.wait = waitMin(a.p, ZBY[a.id].wait); a.wait15 = waitMin(a.p15, ZBY[a.id].wait); });
        tr = trafficEngine(zones, true); tr.steered = steerK; tr.effect = { savedMin: raw.reduce((s, r) => s + r.savedMin, 0) * steerK, moved: raw.length };
        tr.recs = raw;
      }
      const eqFrame = this.providers.equipment.getFrame(frame);
      const eq = equipmentEngine(eqFrame);
      const clubCap = frame.clubCap, load = clamp(frame.people / Math.max(clubCap, 1), 0, 1);
      const events = this.anom.evaluate(zones, eq, now, this.scen && this.scen.active ? 0 : (dtSim == null ? 0.16 : dtSim), { people: frame.people, clubCap, load, closed: this.closedZones });
      if (this.scen && this.scen.active) this.scen.injectEvents(this.anom, now);
      const act = [...this.anom.active.values()];
      // прогноз пика
      let peak = null;
      for (let m = Math.ceil(now.min); m < 1380; m += 2) { const L = sim.loadAt(now.dow, m); if (!peak || L > peak.load) peak = { min: m, load: L }; }
      if (peak && peak.min - now.min < 4) peak = Object.assign(peak, { now: true });
      if (this.scen && this.scen.active && this.scen.peak) peak = this.scen.peak(peak);
      const critical = zones.filter(z => z.level === 'CRITICAL');
      const snap = {
        ts: Date.now(), mode: this.mode, clock: now, clubCap, clubName: frame.clubName, people: frame.people, load, zones, zoneById: {}, flows: frame.flows || [], entrance: frame.entrance || { in10: 0, out10: 0 },
        eq, traffic: tr, events: this.anom.history.slice(-40), activeEvents: act, peak, critical, stale: !!frame.stale, scenario: this.scen && this.scen.active ? this.scen.phase : null,
        kpis: { people: frame.people, load, peakAt: peak ? peak.min : null, critical: critical.length, eqAlerts: eq.alerts.length, aiEvents: 0 }
      };
      zones.forEach(z => { snap.zoneById[z.id] = z; });
      if (this.scen && this.scen.active && this.scen.override) this.scen.override(snap);
      const rep = dailyReport(snap, sim); snap.report = rep; snap.kpis.aiEvents = this.scen && this.scen.active && this.scen.aiEvents != null ? this.scen.aiEvents : rep.facts.aiEvents;
      snap.summary = AI.statusLine(snap);
      this.series.push({ t: this.simClock, people: frame.people }); if (this.series.length > 90) this.series.shift();
      this.snap = snap; this.listeners.forEach(f => { try { f(snap); } catch (e) { /* UI не должен ронять оркестратор */ } });
      return snap;
    }
  }
  AI.Orchestrator = Orchestrator;

  /* ============================================================ ТЕКСТОВЫЕ СВОДКИ (только по готовым числам) */
  const zr = id => ZBY[id].ru;
  AI.statusLine = function (s) {
    if (s.empty) return 'Нет данных от камер';
    const top = s.zones.filter(z => z.hasEq).sort((a, b) => b.p - a.p)[0], cr = s.critical.length, calm = s.zones.filter(z => z.hasEq).sort((a, b) => a.p - b.p)[0];
    if (!top) return 'Загрузка клуба — ' + Math.round(s.load * 100) + '%. Данных по зонам пока нет.';
    const pk = s.peak ? ' Пик ожидается около ' + hm(s.peak.min) + '.' : '';
    if (cr) return 'Критичная загрузка ' + (cr === 1 ? 'в зоне ' : 'в ' + cr + ' зонах: ') + s.critical.map(z => '«' + z.ru + '»').join(', ') + '.' + pk;
    if (top && top.p >= TH.busy) return 'Главная точка скопления — «' + top.ru + '» (' + Math.round(top.p * 100) + '%). Свободнее всего «' + calm.ru + '».' + pk;
    return 'Клуб работает в штатном режиме: загрузка ' + Math.round(s.load * 100) + '%.' + pk;
  };

  /* ============================================================ КОМАНДНЫЙ ИНТЕРФЕЙС УПРАВЛЯЮЩЕГО */
  // Отвечает только по структурным данным оркестратора. Придумывать числа и события он не умеет.
  const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е');
  function ask(q, s, ret) {
    const n = norm(q), src = [];
    if (!s || s.empty) return { intent: 'nodata', text: 'Данных от камер пока нет — подключите источник или включите демо-режим.', src };
    const hot = s.zones.filter(z => z.hasEq).sort((a, b) => b.p - a.p), calm = s.zones.filter(z => z.hasEq).sort((a, b) => a.p - b.p)[0];
    if (!hot.length && /(что (сейчас )?происходит|как дела|состояни|ситуаци|статус|обстановк|свободн|зон)/.test(n)) return { intent: 'nodata', text: 'Источник пока не передал данные по зонам. Общая загрузка клуба — ' + Math.round(s.load * 100) + '% (' + s.people + ' чел.).', src: ['Occupancy Engine'] };
    const zoneHit = ZDEF.find(z => n.indexOf(norm(z.ru)) >= 0 || n.indexOf(norm(z.en)) >= 0 || (z.id === 'free' && /свободн\S* вес|гантел|штанг/.test(n)) || (z.id === 'cardio' && /кардио|дорожк/.test(n)) || (z.id === 'func' && /функц/.test(n)));
    if (/(что (сейчас )?происходит|как дела|состояни|ситуаци|статус|what.?s happening|status|обстановк)/.test(n) && !zoneHit) {
      src.push('Occupancy Engine', 'Traffic Engine');
      const pk = s.peak ? ' Пик нагрузки ожидается около ' + hm(s.peak.min) + '.' : '';
      return { intent: 'status', text: 'Загрузка клуба — ' + Math.round(s.load * 100) + '% (' + s.people + ' ' + plural(s.people, ['человек', 'человека', 'человек']) + '). Основная точка скопления — «' + hot[0].ru + '» (' + Math.round(hot[0].p * 100) + '%). Свободный запас есть в зоне «' + calm.ru + '» (' + Math.round(calm.p * 100) + '%).' + pk + (s.critical.length ? ' Критичных зон: ' + s.critical.length + '.' : ''), src };
    }
    if (/(проблем|инцидент|событи|что было|за сегодня|alerts?|issues?)/.test(n)) {
      src.push('Anomaly Engine', 'Equipment Engine');
      const ev = s.report.events.slice(-6), eqa = s.eq.alerts;
      if (!ev.length && !eqa.length) return { intent: 'problems', text: 'Сегодня значимых событий не зафиксировано.', src };
      const lines = ev.map(e => '• ' + hm(e.startMin) + ' — ' + e.title + (e.dur ? ' (' + Math.round(e.dur) + ' мин)' : '') + (e.active ? ' · идёт сейчас' : ''));
      const eqt = eqa.length ? 'Оборудование: ' + eqa.map(a => a.title).join('; ') + '.' : '';
      return { intent: 'problems', text: 'За сегодня зафиксировано ' + s.report.facts.aiEvents + ' ' + plural(s.report.facts.aiEvents, ['событие', 'события', 'событий']) + (lines.length ? ':\n' + lines.join('\n') : '.') + (eqt ? '\n' + eqt : ''), src };
    }
    if (/(оборудован|тренажер|поломк|сломан|неисправн|станци)/.test(n) && !zoneHit) {
      src.push('Equipment Engine'); const c = s.eq.counts;
      return { intent: 'equipment', text: 'Тренажёров под наблюдением — ' + s.eq.total + ': свободно ' + c.AVAILABLE + ', занято ' + c.IN_USE + ', очередь у ' + c.QUEUE + ', без связи ' + c.OFFLINE + ', на обслуживании ' + c.MAINTENANCE + ', статус неизвестен ' + c.UNKNOWN + '.' + (s.eq.alerts.length ? '\nТребуют внимания: ' + s.eq.alerts.map(a => a.title).join('; ') + '.' : ''), src };
    }
    if (/(пик|когда будет|peak|максимум)/.test(n)) {
      src.push('Prediction Engine'); const nc = s.traffic.nextCritical;
      return { intent: 'peak', text: s.peak ? 'Пик нагрузки по прогнозу — около ' + hm(s.peak.min) + ' (≈' + Math.round(s.peak.load * 100) + '% типовой загрузки).' + (nc ? ' Ближайшая критичная зона — «' + zr(nc.zone) + '»' + (nc.inMin ? ' через ~' + nc.inMin + ' мин.' : ' уже сейчас.') : '') : 'На сегодня пик уже пройден.', src };
    }
    if (/(отчет|итог|report|summary|сводк)/.test(n)) { src.push('Daily Report'); return { intent: 'report', text: s.report.summary, src, report: true }; }
    if (/(возвращ|отток|retention|вовлечен|перерыв)/.test(n)) {
      src.push('Return Engine'); if (!ret) return { intent: 'retention', text: 'Данных Return Engine пока нет.', src };
      return { intent: 'retention', text: 'Сигналы вовлечённости (обезличенно): норма — ' + ret.counts.NORMAL + ', наблюдать — ' + ret.counts.WATCH + ', снижение вовлечённости — ' + ret.counts.DECLINING + '. Рекомендуется мягкая рассылка «возвращение» с пониженной стартовой нагрузкой.', src };
    }
    if (zoneHit) {
      const z = s.zoneById[zoneHit.id]; src.push('Occupancy Engine');
      if (!z) return { intent: 'zone', text: 'По зоне «' + zoneHit.ru + '» источник данные не передаёт.', src };
      return { intent: 'zone', text: '«' + z.ru + '»: сейчас ' + z.count + ' ' + plural(z.count, ['человек', 'человека', 'человек']) + ', загрузка ' + Math.round(z.p * 100) + '% (' + z.level + '), среднее время на станции ' + Math.round(z.dwell) + ' мин. Через 15 минут — ' + Math.round(z.p15 * 100) + '%.' + (z.wait15 >= 1 ? ' Ожидание тренажёра ≈ ' + Math.round(z.wait15) + ' мин.' : ''), src };
    }
    if (/(свободн|где мало|где можно|запас)/.test(n)) { src.push('Occupancy Engine'); const free = hot.slice(-3).reverse(); return { intent: 'free', text: 'Больше всего места: ' + free.map(z => '«' + z.ru + '» — ' + Math.round(z.p * 100) + '%').join(', ') + '.', src }; }
    return { intent: 'unknown', text: 'Я отвечаю только по данным DDX Vision: состояние клуба, зоны, оборудование, события, пик, отчёт, вовлечённость. Попробуйте один из вопросов ниже.', src };
  }
  AI.ask = ask;

  /* ============================================================ ЗАГРУЗКА БОЕВЫХ НАСТРОЕК ============================================================ */
  // Токен хранится только в памяти страницы — в localStorage его не кладём.
  AI.liveConfigHint = { baseUrl: '', token: '' };
})(typeof window !== 'undefined' ? window : globalThis);
