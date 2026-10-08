/* Заглушка исходного приложения для тестов движков: те же типы оборудования и кривая загрузки, что в index.html */
export const T = {
  tread: { n: 'Беговая дорожка', b: 'Technogym', z: 'cardio', d: [14, 32] }, bike: { n: 'Велотренажёр', b: 'Matrix', z: 'cardio', d: [12, 28] },
  ellip: { n: 'Эллипс', b: 'Matrix', z: 'cardio', d: [12, 26] }, row: { n: 'Гребной тренажёр', b: 'Technogym', z: 'cardio', d: [8, 18] }, climb: { n: 'Лестница', b: 'Matrix', z: 'cardio', d: [8, 16] },
  legpress: { n: 'Жим ногами', b: 'Matrix', z: 'machines', d: [8, 15] }, legext: { n: 'Разгибание ног', b: 'Technogym', z: 'machines', d: [6, 11] }, legcurl: { n: 'Сгибание ног', b: 'Technogym', z: 'machines', d: [6, 11] },
  glute: { n: 'Ягодичный мост', b: 'Matrix', z: 'machines', d: [7, 12] }, smith: { n: 'Машина Смита', b: 'Matrix', z: 'machines', d: [9, 16] }, grav: { n: 'Гравитрон', b: 'Technogym', z: 'machines', d: [6, 10] },
  lat: { n: 'Тяга верхнего блока', b: 'Technogym', z: 'machines', d: [7, 12] }, srow: { n: 'Тяга горизонтального блока', b: 'Technogym', z: 'machines', d: [7, 12] }, hyper: { n: 'Гиперэкстензия', b: 'Matrix', z: 'machines', d: [5, 9] },
  cross: { n: 'Кроссовер', b: 'Matrix', z: 'machines', d: [7, 13] }, fly: { n: 'Баттерфляй', b: 'Technogym', z: 'machines', d: [6, 10] }, chest: { n: 'Жим от груди', b: 'Technogym', z: 'machines', d: [6, 11] },
  shoulder: { n: 'Жим вверх', b: 'Technogym', z: 'machines', d: [6, 10] }, rack: { n: 'Силовая рама', b: 'Pure Strength', z: 'free', d: [12, 24] }, bench: { n: 'Скамья для жима', b: 'Pure Strength', z: 'free', d: [10, 18] },
  adj: { n: 'Регулируемая скамья', b: 'Pure Strength', z: 'free', d: [8, 15] }, db: { n: 'Гантельный ряд 2–50 кг', b: 'Pure Strength', z: 'free', d: [6, 14], cap: 6 }, plat: { n: 'Помост для становой', b: 'DDX Athletic', z: 'func', d: [10, 18] }, trx: { n: 'Петли TRX', b: 'TRX', z: 'trx', d: [8, 14] }
};
const WD = [0, 0, 0, 0, 0, 0, .2, .42, .47, .33, .24, .22, .27, .3, .27, .3, .42, .64, .86, .95, .8, .56, .34, .16, .05];
const WE = [0, 0, 0, 0, 0, 0, .08, .16, .3, .46, .6, .66, .62, .55, .5, .48, .5, .52, .5, .44, .36, .26, .16, .08, .03];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export function loadAt(dow, min, k = 1, seed = 1.1) {
  if (min < 360 || min >= 1440) return 0;
  const P = dow >= 5 ? WE : WD, h = min / 60, i = Math.floor(h), f = h - i, s = f * f * (3 - 2 * f);
  let v = P[i] + (P[i + 1] - P[i]) * s; if (dow === 4 && h > 18) v *= 0.86; v *= k;
  v += Math.sin(min / 37 + dow * 1.7 + seed) * 0.025 + Math.sin(min / 13 + seed * 3) * 0.012;
  return clamp(v, 0.02, 1);
}
export function buildEq() {
  const L = [], add = (t, x, y, n) => L.push({ id: t + n, t, n, x, y });
  for (let i = 0; i < 8; i++) add('tread', 22 + i * 40, 54, i + 1);
  ['bike', 'bike', 'bike', 'bike', 'ellip', 'ellip', 'ellip', 'ellip', 'row', 'row', 'climb'].forEach((t, i, a) => add(t, 20 + i * 29.6, 98, a.slice(0, i + 1).filter(x => x === t).length));
  ['legpress', 'legpress', 'legext', 'legcurl', 'glute', 'smith', 'grav', 'lat', 'lat', 'srow', 'hyper', 'cross', 'cross', 'fly', 'chest', 'shoulder'].forEach((t, i, a) => add(t, 26 + (i % 4) * 46, 172 + Math.floor(i / 4) * 31, a.slice(0, i + 1).filter(x => x === t).length));
  for (let i = 0; i < 3; i++) add('rack', 226 + i * 40, 168, i + 1);
  for (let i = 0; i < 3; i++) add('bench', 226 + i * 40, 206, i + 1);
  for (let i = 0; i < 4; i++) add('adj', 226 + i * 30, 236, i + 1);
  add('db', 226, 264, 1); add('plat', 24, 336, 1); add('plat', 72, 336, 2);
  for (let i = 0; i < 6; i++) add('trx', 192 + (i % 2) * 36, 340 + Math.floor(i / 2) * 22, i + 1);
  return L;
}
/* load — желаемая загрузка 0..1, busyFrac задаёт, какая доля тренажёров занята (детерминированно) */
export function makeSim({ dow = 0, min = 19 * 60 + 5, cap = 130, busyFrac = null, clubId = 'vat' } = {}) {
  const eq = buildEq(), L = loadAt(dow, min), frac = busyFrac == null ? clamp(L * 1.05, 0, 0.98) : busyFrac;
  const ss = {}; let k = 0;
  eq.forEach(e => {
    const ti = T[e.t]; k++;
    const r = ((k * 2654435761) % 1000) / 1000;
    const s = { s: 'free', left: 0, since: 0, sets: 0, total: 4, used: 0, util: .5 };
    if (ti.cap) s.used = Math.round(frac * ti.cap); else if (r < frac) { s.s = 'busy'; s.left = 1 + r * (ti.d[1] - 1); s.since = 2 + r * ti.d[0]; }
    ss[e.id] = s;
  });
  ss.tread6 = { s: 'service', left: 0, since: 0, used: 0 };
  if (ss.bench2) { ss.bench2.s = 'busy'; ss.bench2.since = 41; ss.bench2.left = 12; }
  const now = { dow, min };
  const sim = {
    ss, eq: () => eq, now: () => now, realNow: () => now, loadAt: (d, m) => loadAt(d, m), curLoad: () => L, people: () => Math.round(L * cap), clubCap: () => cap, clubId: () => clubId, clubName: () => 'Тест',
    eqState: id => { const s = ss[id]; const st = s.s === 'service' ? 'service' : T[eq.find(e => e.id === id).t].cap ? (s.used >= T[eq.find(e => e.id === id).t].cap ? 'busy' : 'free') : s.s === 'busy' ? (s.left <= 3 ? 'soon' : 'busy') : 'free'; return { st, left: s.left || 0, since: s.since || 0, sets: s.sets || 0, total: s.total || 0, used: s.used || 0, util: s.util || 0, reserved: false }; },
    type: t => T[t], trend: () => loadAt(dow, min + 20) - L,
    studioAt: m => (m >= 19 * 60 && m < 19 * 60 + 45 ? .8 : .05), classAt: (d, m) => (m >= 19 * 60 && m < 19 * 60 + 45 ? .8 : .05),
    markUnavailable(ids) { ids.forEach(id => { ss[id] = { s: 'service', left: 0, since: 0, used: 0 }; }); },
    setTime(d, m) { now.dow = d; now.min = m; }
  };
  return sim;
}
