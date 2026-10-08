import assert from 'node:assert/strict';
import '../ai/core.js'; import '../ai/routing.js';
const AI = globalThis.DDXAI, R = AI.Routing;
let n = 0; const t = (name, fn) => { try { fn(); n++; console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n   ', e.message); process.exitCode = 1; } };
const GOALS = {
  chest: { ex: [['Жим штанги лёжа', 'bench', 4], ['Жим гантелей под углом', 'adj', 3], ['Жим от груди', 'chest', 3], ['Баттерфляй', 'fly', 3], ['Кроссовер', 'cross', 3], ['Жим вверх', 'shoulder', 3], ['Заминка: эллипс', 'ellip', 1]] },
  legs: { ex: [['Приседания со штангой', 'rack', 4], ['Жим ногами', 'legpress', 4], ['Разгибание ног', 'legext', 3], ['Сгибание ног', 'legcurl', 3], ['Ягодичный мост', 'glute', 3], ['Икры в Смите', 'smith', 3], ['Заминка: велотренажёр', 'bike', 1]] }
};
// ctx: waits — словарь «тип → минуты ожидания»
const mk = (waits, extra) => Object.assign({ goals: GOALS, pos: { x: 100, y: 200 }, mPerUnit: 0.1, limits: [], wait: type => ({ w: waits[type] == null ? 0 : waits[type], id: type + '1', x: 100 + (type === 'cross' ? 180 : 40), y: 200 }) }, extra);
const steps = names => names.map(nm => ({ ex: Object.values(GOALS).flatMap(g => g.ex).find(e => e[0] === nm) }));

t('занято надолго, но следующее свободно → перестановка, программа не теряется', () => {
  const st = steps(['Жим от груди', 'Баттерфляй', 'Кроссовер', 'Жим вверх', 'Заминка: эллипс']);
  const r = R.evaluate(st, 0, mk({ chest: 7 })); assert.equal(r.type, 'reorder'); assert.equal(r.waitBefore, 7); assert.equal(r.waitAfter, 0);
});
t('перестановка не ставит изоляцию грудь перед базовым жимом на грудь', () => {
  const st = steps(['Жим от груди', 'Баттерфляй']);
  const r = R.evaluate(st, 0, mk({ chest: 7 }));
  assert.notEqual(r.type, 'reorder', 'Баттерфляй (изоляция) нельзя ставить перед Жимом от груди (базовым)');
});
t('нет допустимой перестановки → замена на эквивалент той же мышцы', () => {
  const st = steps(['Жим от груди', 'Баттерфляй']);
  const r = R.evaluate(st, 0, mk({ chest: 7, fly: 5, adj: 6, bench: 6 })); // баттерфляй, скамьи заняты, кроссовер свободен
  assert.equal(r.type, 'sub'); assert.equal(R.metaOf(r.to).m, 'chest'); assert.equal(r.to[1], 'cross'); assert.equal(r.waitAfter, 0);
});
t('замена не тяжелее исходного и не повторяет уже сделанное', () => {
  const st = steps(['Жим от груди', 'Баттерфляй']);
  const r = R.evaluate(st, 0, mk({ chest: 7, fly: 5, cross: 6 })); // свободны только bench/adj (тяжелее или нет в плане)
  if (r.type === 'sub') { assert.ok(R.metaOf(r.to).f <= R.metaOf(st[0].ex).f); assert.notEqual(r.to[0], 'Баттерфляй'); }
});
t('короткая очередь → ничего не меняем', () => { assert.equal(R.evaluate(steps(['Жим от груди', 'Кроссовер']), 0, mk({ chest: 2 })), null); });
t('заминку не трогаем', () => { assert.equal(R.evaluate(steps(['Заминка: эллипс']), 0, mk({ ellip: 20 })), null); });
t('усталая мышца: базовое упражнение на неё не подставляем, берём лёгкую изоляцию', () => {
  const st = steps(['Жим штанги лёжа', 'Жим гантелей под углом', 'Жим от груди', 'Кроссовер']); // bench+adj сделаны → грудь устала
  const r = R.evaluate(st, 2, mk({ chest: 9, cross: 0 }));
  assert.ok(r && (r.type === 'reorder' || r.type === 'sub')); assert.equal(R.metaOf(r.to).cls, 'iso');
});
t('ограничения: колени → не берём упражнения с нагрузкой на колени', () => {
  const st = steps(['Приседания со штангой', 'Жим ногами', 'Разгибание ног', 'Сгибание ног']);
  const r = R.evaluate(st, 1, mk({ legpress: 8, legext: 0, legcurl: 0 }, { limits: ['knee'] }));
  assert.ok(r); assert.ok(!(R.metaOf(r.to).st.indexOf('knee') >= 0), 'выбрано ' + r.to[0]);
});
t('расстояние учитывается: при равных условиях выбираем ближний тренажёр', () => {
  const st = steps(['Жим от груди', 'Баттерфляй']);
  const ctx = mk({ chest: 8, fly: 5, adj: 6, bench: 6 }); // свободен только кроссовер, он дальше всех (180 ед. = 18 м)
  const r = R.evaluate(st, 0, ctx); assert.equal(r.type, 'sub'); assert.ok(Math.abs(r.distM - 18) < 0.5, 'dist ' + r.distM);
});
t('применение: перестановка и замена меняют маршрут, ничего не теряя', () => {
  let st = steps(['Жим от груди', 'Кроссовер', 'Жим вверх']); const names0 = st.map(s => s.ex[0]).sort();
  R.apply(st, R.evaluate(st, 0, mk({ chest: 7 }))); assert.deepEqual(st.map(s => s.ex[0]).sort(), names0); assert.equal(st[0].ex[0], 'Жим вверх'); // перестановка: плечи вперёд, грудь позже
  st = steps(['Жим от груди', 'Баттерфляй']); R.apply(st, R.evaluate(st, 0, mk({ chest: 7, fly: 5, adj: 6, bench: 6 }))); assert.equal(st[0].orig[0], 'Жим от груди'); assert.equal(st.length, 2);
});
t('возврат: оригинал освободился, замена ещё не начата → возвращаем', () => {
  const st = steps(['Жим от груди', 'Баттерфляй']); R.apply(st, R.evaluate(st, 0, mk({ chest: 7, fly: 5, adj: 6, bench: 6 })));
  assert.equal(R.checkReturn(st, 0, mk({ chest: 6 })), null, 'ещё занят');
  const back = R.checkReturn(st, 0, mk({ chest: 0 })); assert.equal(back.type, 'return'); R.applyReturn(st, back); assert.equal(st[0].ex[0], 'Жим от груди'); assert.equal(st[0].orig, undefined);
});
t('возврата нет для упражнения, которое уже в прошлом', () => {
  const st = steps(['Жим от груди', 'Баттерфляй']); R.apply(st, R.evaluate(st, 0, mk({ chest: 7, fly: 5, adj: 6, bench: 6 })));
  assert.equal(R.checkReturn(st, 1, mk({ chest: 0 })), null);
});
t('если подходящего ничего нет → совет подождать, а не случайная замена', () => {
  const st = steps(['Жим вверх', 'Заминка: эллипс']); const r = R.evaluate(st, 0, mk({ shoulder: 9, adj: 9, db: 9 }));
  assert.equal(r.type, 'wait');
});
console.log(n + ' проверок routing пройдено');
