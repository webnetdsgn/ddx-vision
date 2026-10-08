import assert from 'node:assert/strict';
import '../ai/core.js'; import '../ai/twin.js';
const AI = globalThis.DDXAI;
let n = 0; const t = (name, fn) => { try { fn(); n++; console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n   ', e.message); process.exitCode = 1; } };
const pro = AI.Members.make('pro'), nw = AI.Members.make('new'), bk = AI.Members.make('back');

t('опытный участник: показатели дают +14% / 82% / +11% / 78% / ON TRACK', () => {
  const b = AI.bodyTwin(pro);
  assert.equal(Math.round(b.strength.pct * 100), 14, 'strength ' + b.strength.pct);
  assert.equal(Math.round(b.consistency.pct * 100), 82, 'consistency ' + b.consistency.pct);
  assert.equal(Math.round(b.volume.pct * 100), 11, 'volume ' + b.volume.pct);
  assert.equal(Math.round(b.goal.progress * 100), 78, 'goal ' + b.goal.progress);
  assert.equal(b.goal.status, 'ON TRACK', b.goal.status + ' ' + JSON.stringify({ s: b.goal.slope, l: b.goal.daysLeft }));
  assert.equal(b.body.state, 'ok'); assert.equal(b.body.ageDays, 3);
});
t('новый участник: INSUFFICIENT DATA вместо выдуманных чисел', () => {
  const b = AI.bodyTwin(nw);
  assert.equal(b.strength.state, 'insufficient'); assert.equal(b.consistency.state, 'insufficient'); assert.equal(b.volume.state, 'insufficient');
  assert.equal(b.body.state, 'insufficient'); assert.equal(b.goal.status, 'INSUFFICIENT DATA'); assert.equal(AI.Progress.facts(b).length, 0);
});
t('возврат после перерыва: сила — мало данных, сигнал вовлечённости ≠ NORMAL', () => {
  const b = AI.bodyTwin(bk); assert.equal(b.strength.state, 'insufficient');
  const r = AI.Return.ofMember(bk); assert.equal(r.daysSince, 9); assert.equal(r.signal, 'DECLINING'); assert.ok(r.why.length > 0);
});
t('согласие: без источника InBody нет композиции тела и прогноза цели', () => {
  const b = AI.bodyTwin(pro, { inbody: false }); assert.equal(b.body.state, 'insufficient'); assert.equal(b.body.reason, 'consent'); assert.equal(b.goal.status, 'INSUFFICIENT DATA');
  assert.equal(b.strength.state, 'ok');
});
t('согласие: без источника тренировок нет силы, объёма и регулярности', () => {
  const b = AI.bodyTwin(pro, { workouts: false }); ['strength', 'consistency', 'volume'].forEach(k => assert.equal(b[k].reason, 'consent'));
});
t('пояснения: числа берутся только из фактов', () => {
  const b = AI.bodyTwin(pro), facts = AI.Progress.facts(b), lines = AI.Progress.explainTemplate(facts);
  assert.ok(lines.length >= 3); assert.ok(AI.Progress.guardNumbers(lines, facts).ok, JSON.stringify(AI.Progress.guardNumbers(lines, facts)));
  assert.ok(lines.some(l => /82%/.test(l))); assert.ok(lines.some(l => /сохраните текущий вес/.test(l)));
});
t('защита: выдуманное число в тексте ловится', () => {
  const facts = AI.Progress.facts(AI.bodyTwin(pro)); const g = AI.Progress.guardNumbers(['Сила выросла на 37%.'], facts); assert.equal(g.ok, false); assert.deepEqual(g.bad, ['37']);
});
t('LLM-пояснитель с выдумкой отклоняется и заменяется шаблоном', async () => {
  const facts = AI.Progress.facts(AI.bodyTwin(pro));
  class Liar extends AI.Progress.ExplainerProvider { async explain() { return ['Сила выросла на 99%.']; } }
  const r = await AI.Progress.safeExplain(new Liar(), facts); assert.equal(r.fallback, true); assert.ok(AI.Progress.guardNumbers(r.lines, facts).ok);
  const r2 = await AI.Progress.safeExplain(new AI.Progress.LlmExplainer(), facts); assert.equal(r2.fallback, true);
});
t('Return Engine: пороги сигналов', () => {
  const mk = (days, per) => days.map(d => ({ day: d, done: true, planned: true }));
  assert.equal(AI.Return.of(mk([-1, -3, -5, -8, -10, -12, -30, -32, -34, -36, -38])).signal, 'NORMAL');
  assert.equal(AI.Return.of(mk([-9, -11, -14, -30, -32, -34, -36, -38])).signal, 'WATCH');
  assert.equal(AI.Return.of(mk([-16, -30, -32, -34, -36, -38])).signal, 'DECLINING');
});
t('Welcome back: чем дольше перерыв, тем мягче старт', () => {
  assert.equal(AI.Return.welcome(3).loadCutPct, 0); assert.equal(AI.Return.welcome(9).loadCutPct, 15); assert.equal(AI.Return.welcome(20).loadCutPct, 25); assert.equal(AI.Return.welcome(45).loadCutPct, 35);
  const p = AI.welcomePlan([['A', 'rack', 4], ['B', 'legpress', 4], ['C', 'legext', 3], ['D', 'legcurl', 3], ['E', 'glute', 3], ['F', 'smith', 3], ['G', 'bike', 1]], 9);
  assert.equal(p.ex.length, 5); assert.equal(p.ex[0][2], 3); assert.equal(p.ex[4][2], 1);
});
t('когорта клуба: обезличена, считается детерминированно', () => {
  const a = AI.Return.cohort('vat', 1170), b = AI.Return.cohort('vat', 1170);
  assert.equal(a, b); assert.equal(a.counts.NORMAL + a.counts.WATCH + a.counts.DECLINING, 1170); assert.ok(a.counts.NORMAL > 0.6 * 1170);
  a.flagged.forEach(f => { assert.match(f.id, /^M-\d{4}$/); assert.ok(!('name' in f)); });
});
console.log(n + ' проверок twin пройдено');
