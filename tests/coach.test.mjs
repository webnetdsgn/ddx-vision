import assert from 'node:assert/strict';
import '../ai/core.js'; import '../ai/coach.js';
const AI = globalThis.DDXAI;
let n = 0; const t = (name, fn) => { try { fn(); n++; console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n   ', e.message); process.exitCode = 1; } };
const run = (opts, plan, sec = 60) => {
  const p = new AI.SimulatedPoseProvider({ exercise: opts.ex, reps: plan, count: 10 });
  const s = new AI.CoachSession({ provider: p, exercise: opts.auto ? 'auto' : opts.ex, target: 99 });
  const states = []; for (let i = 0; i < sec * 30; i++) { const v = s.step(1 / 30); if (i % 30 === 0) states.push(v); }
  return { s, p, states };
};
const good = (n, o = {}) => Array.from({ length: n }, () => Object.assign({ depth: 1.03, a: 2.4, b: 2.3, asym: 0 }, o));

for (const ex of AI.COACH_EXLIST) {
  t(ex + ': автоопределение и счёт 8 повторов', () => {
    const { s } = run({ ex, auto: true }, good(8), 60);
    assert.equal(s.exercise, ex, 'распознано ' + s.exercise); assert.equal(s.reps.length, 8, 'повторов ' + s.reps.length);
    s.reps.forEach(r => { assert.equal(r.range, 'GOOD', 'range ' + r.range + ' u=' + r.peakU.toFixed(2)); assert.equal(r.tempo, 'GOOD', 'tempo ecc=' + r.ecc.toFixed(2)); assert.equal(r.symmetry, 'NORMAL', 'sym diff=' + r.diff.toFixed(1)); });
  });
  t(ex + ': темп измеряется в пределах ±20% от заданного', () => {
    const { s } = run({ ex, auto: false }, good(5, { a: 3, b: 3 }), 40), want = 3;
    s.reps.forEach(r => assert.ok(Math.abs(r.ecc - want) / want < 0.2, 'ecc=' + r.ecc.toFixed(2)));
  });
  t(ex + ': быстрый повтор → FAST и подсказка про темп', () => {
    const plan = good(4); plan[2] = { depth: 1.03, a: 0.9, b: 0.9, asym: 0 };
    const { s } = run({ ex, auto: false }, plan, 30);
    assert.equal(s.reps.length, 4); const fast = ex === 'squat' || ex === 'lunge' ? s.reps[2] : s.reps[2];
    assert.equal(fast.tempo, 'FAST'); assert.equal(AI.coachCue(ex, { type: 'rep', rep: fast }).code, 'tempo_fast');
  });
  t(ex + ': неполный повтор не засчитывается', () => {
    const plan = good(4); plan[1] = { depth: 0.55, a: 2.2, b: 2.2, asym: 0 };
    const { s } = run({ ex, auto: false }, plan, 30);
    assert.equal(s.reps.length, 3, 'засчитано ' + s.reps.length); assert.equal(s.counter.partials, 1);
  });
}
t('асимметрия 14° → WATCH/UNEVEN и подсказка про сторону', () => {
  const { s } = run({ ex: 'squat', auto: false }, good(3, { asym: 14 }), 30);
  s.reps.forEach(r => { assert.notEqual(r.symmetry, 'NORMAL', 'diff=' + r.diff.toFixed(1)); assert.ok(r.lagging === 'L' || r.lagging === 'R'); });
  assert.equal(AI.coachCue('squat', { type: 'rep', rep: s.reps[0] }).code, 'asym');
});
t('мелкая амплитуда (u≈0.82) → SHALLOW засчитан, подсказка про амплитуду', () => {
  const { s } = run({ ex: 'squat', auto: false }, good(3, { depth: 0.84 }), 30);
  assert.equal(s.reps.length, 3); assert.equal(s.reps[0].range, 'SHALLOW'); assert.equal(AI.coachCue('squat', { type: 'rep', rep: s.reps[0] }).code, 'rom');
});
t('хороший повтор → «Хороший диапазон»', () => {
  const { s } = run({ ex: 'press', auto: false }, good(2), 20);
  const c = AI.coachCue('press', { type: 'rep', rep: s.reps[0] }); assert.equal(c.code, 'good'); assert.ok(c.text.length < 60);
});
t('видео не сохраняется: сводка сессии содержит 0 байт видео', () => {
  const { s } = run({ ex: 'curl', auto: true }, good(4), 25); const sum = s.end(); assert.equal(sum.bytesVideo, 0); assert.equal(sum.reps, 4);
});
t('на входе сессии только ключевые точки (17 × 3)', () => {
  const p = new AI.SimulatedPoseProvider({ exercise: 'squat' }), f = p.read(0.1); assert.equal(f.kp3.length, 17); f.kp3.forEach(k => assert.equal(k.length, 3)); assert.equal(f.kp2.length, 17);
});
console.log(n + ' проверок coach пройдено');
