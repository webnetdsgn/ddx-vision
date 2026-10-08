import assert from 'node:assert/strict';
import { makeSim } from './fakesim.mjs';
import '../ai/core.js';
const AI = globalThis.DDXAI;
let n = 0; const t = (name, fn) => { try { fn(); n++; console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n   ', e.message); process.exitCode = 1; } };

t('уровни загрузки по порогам', () => {
  assert.equal(AI.levelOf(0.41), 'LOW'); assert.equal(AI.levelOf(0.56), 'NORMAL'); assert.equal(AI.levelOf(0.73), 'BUSY');
  assert.equal(AI.levelOf(0.94), 'BUSY'); assert.equal(AI.levelOf(0.95), 'CRITICAL'); assert.equal(AI.levelOf(0), 'LOW');
});
t('allocate: сумма совпадает точно', () => {
  for (const total of [0, 1, 7, 130, 284]) { const r = AI.util.allocate(total, [3.3, 0.4, 9.9, 1.2, 0.05]); assert.equal(r.reduce((a, b) => a + b, 0), total); }
});
t('оркестратор: часы пик — людей по зонам ровно столько, сколько в клубе', () => {
  const sim = makeSim({ dow: 0, min: 19 * 60 + 5 }), o = new AI.Orchestrator(sim); const s = o.update();
  assert.equal(s.zones.reduce((a, z) => a + z.count, 0), s.people);
  assert.equal(s.zones.length, 10);
  s.zones.forEach(z => { assert.ok(z.p >= 0 && z.p <= 1, z.id + ' p'); assert.ok(z.p15 >= 0 && z.p15 <= 1); assert.ok(AI.LEVEL[z.level]); });
});
t('утро: загрузка меньше, чем вечером', () => {
  const am = new AI.Orchestrator(makeSim({ min: 10 * 60 + 30 })).update(), pm = new AI.Orchestrator(makeSim({ min: 19 * 60 })).update();
  assert.ok(am.people < pm.people); assert.ok(am.load < pm.load);
});
t('прогноз +15 мин растёт до пика и падает после него', () => {
  const up = new AI.Orchestrator(makeSim({ min: 17 * 60 + 30 })).update(), down = new AI.Orchestrator(makeSim({ min: 20 * 60 + 30 })).update();
  const mean = (s, k) => s.zones.filter(z => z.hasEq).reduce((a, z) => a + z[k] - z.p, 0) / 7;
  assert.ok(mean(up, 'p15') > 0, 'перед пиком должен быть рост'); assert.ok(mean(down, 'p15') < 0, 'после пика должен быть спад');
});
t('оборудование: статусы и счётчики', () => {
  const s = new AI.Orchestrator(makeSim({ min: 19 * 60 })).update();
  assert.equal(s.eq.total, 54); assert.equal(Object.values(s.eq.counts).reduce((a, b) => a + b, 0), 54);
  assert.equal(s.eq.items.find(i => i.id === 'tread6').status, 'MAINTENANCE');
  assert.equal(s.eq.items.find(i => i.id === 'ellip2').status, 'OFFLINE');
  assert.equal(s.eq.items.find(i => i.id === 'adj3').status, 'UNKNOWN');
  assert.ok(s.eq.alerts.length >= 3, 'ожидаем ≥3 оповещения: обслуживание, нет связи, долгий статус');
});
t('Traffic: рекомендации только в зоны с запасом', () => {
  const s = new AI.Orchestrator(makeSim({ min: 19 * 60, busyFrac: 0.97 })).update();
  s.traffic.recs.forEach(r => { assert.ok(s.zoneById[r.to].p15 <= 0.62); assert.ok(r.savedMin >= 0); assert.notEqual(r.from, r.to); });
});
t('Traffic: перераспределение снижает ожидание и прогноз', () => {
  const o = new AI.Orchestrator(makeSim({ min: 19 * 60, busyFrac: 0.95 })); const before = o.update();
  if (!before.traffic.recs.length) return;
  o.setAuto(true); let s; for (let i = 0; i < 40; i++) s = o.update(0.16);
  const f = before.traffic.recs[0].from;
  assert.ok(s.zoneById[f].p15 < before.zoneById[f].p15); assert.ok(s.traffic.effect.savedMin >= 0);
});
t('критичная загрузка через N минут считается от прогноза', () => {
  assert.equal(AI.criticalIn({ p: 0.97, p15: 0.99, p30: 0.99 }), 0);
  assert.equal(AI.criticalIn({ p: 0.9, p15: 0.99, p30: 0.99 }), Math.round(15 * 0.05 / 0.09));
  assert.equal(AI.criticalIn({ p: 0.5, p15: 0.6, p30: 0.7 }), null);
});
t('аномалии: нет «обвинений», у события есть зона и длительность', () => {
  const o = new AI.Orchestrator(makeSim({ min: 19 * 60, busyFrac: 0.97 })); let s; for (let i = 0; i < 30; i++) s = o.update(0.16);
  assert.ok(s.activeEvents.length > 0);
  s.activeEvents.forEach(e => { assert.ok(e.zone); assert.ok(e.dur >= 0); assert.ok(!/(украл|нарушител|подозр|виновн)/i.test(e.title + e.detail)); });
});
t('аномалии закрываются, когда причина исчезла', () => {
  const sim = makeSim({ min: 19 * 60, busyFrac: 0.97 }), o = new AI.Orchestrator(sim); for (let i = 0; i < 30; i++) o.update(0.16);
  const calm = makeSim({ min: 10 * 60, busyFrac: 0.1 }); o.sim = calm; o.providers.camera.sim = calm; o.providers.equipment.sim = calm;
  const s = o.update(0.16); assert.ok(!s.activeEvents.some(e => e.type === 'congestion'));
});
t('отчёт дня: пик, топ-зона, ожидание и сводка из тех же чисел', () => {
  const s = new AI.Orchestrator(makeSim({ min: 21 * 60 })).update(), f = s.report.facts;
  assert.ok(f.peakPct > 50 && f.peakPct <= 100); assert.ok(f.peakTime >= 17 * 60 && f.peakTime <= 21 * 60);
  assert.ok(s.report.summary.indexOf(String(f.peakPeople)) >= 0); assert.ok(s.report.summary.indexOf(AI.util.hm(f.peakTime)) >= 0);
});
t('командный интерфейс: ответы строятся только из снимка', () => {
  const s = new AI.Orchestrator(makeSim({ min: 19 * 60 })).update();
  const a = AI.ask('Что сейчас происходит в клубе?', s); assert.equal(a.intent, 'status'); assert.ok(a.text.indexOf(Math.round(s.load * 100) + '%') >= 0);
  assert.equal(AI.ask('Какие проблемы были сегодня?', s).intent, 'problems');
  assert.equal(AI.ask('сколько тренажёров сломано', s).intent, 'equipment');
  assert.equal(AI.ask('когда пик', s).intent, 'peak');
  assert.equal(AI.ask('кардио', s).intent, 'zone');
  assert.equal(AI.ask('расскажи анекдот', s).intent, 'unknown');
});
t('аномалия «зона пустует»: все станции зоны недоступны при загруженном клубе', () => {
  const sim = makeSim({ min: 19 * 60, busyFrac: 0.8 }); ['legpress1', 'legpress2', 'legext1', 'legcurl1', 'glute1', 'smith1'].forEach(id => sim.markUnavailable([id]));
  const o = new AI.Orchestrator(sim); let s; for (let i = 0; i < 40; i++) s = o.update(0.16);
  assert.ok(s.activeEvents.some(e => e.type === 'zone' && e.zone === 'legs'), JSON.stringify(s.activeEvents.map(e => e.key)));
  o.closedZones = ['legs']; for (let i = 0; i < 3; i++) s = o.update(0.16); assert.ok(!s.activeEvents.some(e => e.type === 'zone'), 'плановое закрытие не должно давать сигнала');
});
t('приватность: роль и права на камеры по зонам', () => {
  const p = AI.privacy; p.setRole('member'); assert.equal(p.can('command'), false); assert.equal(p.can('camera', 'free'), false);
  p.setRole('manager'); assert.equal(p.can('command'), true); assert.equal(p.can('camera', 'free'), true); assert.equal(p.can('camera', 'locker'), false); assert.equal(p.can('camera', 'group'), false);
  assert.ok(p.audit.length >= 1 && p.audit[0].action === 'role.change'); p.setRole('member'); assert.ok(p.audit.length >= 2);
});
console.log(n + ' проверок core пройдено');
