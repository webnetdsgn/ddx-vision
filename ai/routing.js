/* =====================================================================
   DDX Vision — Dynamic Workout Routing.
   Как навигатор: если следующий тренажёр занят надолго, маршрут перестраивается.
   Но не бездумно: меняем только на допустимое (та же мышца, усталость, уже сделанные
   упражнения, ограничения пользователя). Сначала пробуем переставить упражнения,
   потом — заменить на эквивалент. Освободился оригинал — возвращаем его в маршрут.
   Чистые функции: данные о тренажёрах приходят через ctx.
   ===================================================================== */
(function (root) {
  'use strict';
  const AI = root.DDXAI = root.DDXAI || {};

  /* ---------- свойства упражнений (по названию из программ) ---------- */
  // m — мышечная группа, pat — паттерн движения, cls — compound / iso / cardio / cooldown,
  // f — вклад в усталость мышцы, st — зоны нагрузки для ограничений пользователя
  const X = (m, pat, cls, f, st) => ({ m, pat, cls, f, st: st || [] });
  const SQ = X('legs', 'squat', 'compound', 3, ['knee', 'back']), HINGE = X('back', 'hinge', 'compound', 3, ['back']), BENCH = X('chest', 'press-h', 'compound', 3, ['shoulder']);
  const EXM = {
    'Приседания со штангой': SQ, 'Приседания': SQ, 'Жим ногами': X('legs', 'squat', 'compound', 2, ['knee']), 'Выпады с гантелями': X('legs', 'lunge', 'compound', 2, ['knee']),
    'Разгибание ног': X('legs', 'knee-ext', 'iso', 1, ['knee']), 'Сгибание ног': X('legs', 'knee-flex', 'iso', 1), 'Ягодичный мост': X('legs', 'hip-ext', 'iso', 1), 'Икры в Смите': X('legs', 'calf', 'iso', 1),
    'Становая тяга': HINGE, 'Становая на помосте': HINGE, 'Тяга верхнего блока': X('back', 'pull-v', 'compound', 2), 'Тяга горизонтального блока': X('back', 'pull-h', 'compound', 2),
    'Подтягивания в гравитроне': X('back', 'pull-v', 'compound', 2, ['shoulder']), 'Тяга гантели в наклоне': X('back', 'pull-h', 'compound', 2, ['back']), 'Гиперэкстензия': X('back', 'ext', 'iso', 1, ['back']),
    'Жим штанги лёжа': BENCH, 'Жим лёжа': BENCH, 'Жим гантелей под углом': X('chest', 'press-h', 'compound', 2, ['shoulder']), 'Жим от груди': X('chest', 'press-h', 'compound', 2, ['shoulder']),
    'Баттерфляй': X('chest', 'fly', 'iso', 1), 'Кроссовер': X('chest', 'fly', 'iso', 1),
    'Жим вверх': X('shoulders', 'press-v', 'compound', 2, ['shoulder']), 'Жим гантелей сидя': X('shoulders', 'press-v', 'compound', 2, ['shoulder']), 'Разведение гантелей': X('shoulders', 'raise', 'iso', 1),
    'Петли TRX': X('full', 'trx', 'compound', 1)
  };
  // дополнительные эквиваленты, которых нет в программах (название, тип тренажёра, подходов)
  const EXTRA = [['Жим гантелей сидя', 'adj', 3], ['Разведение гантелей', 'db', 3], ['Выпады с гантелями', 'db', 3]];
  const CARDIO = /^(Интервалы|Гребля|Лестница|Велотренажёр|Эллипс)/;
  function metaOf(ex) {
    const n = ex[0]; if (EXM[n]) return EXM[n];
    if (/^Заминка/.test(n)) return X('cooldown', 'cooldown', 'cooldown', 0);
    if (CARDIO.test(n)) return X('cardio', 'cardio', 'cardio', 0);
    return X('full', 'other', 'compound', 1);
  }
  const catalog = goals => { const seen = {}, out = []; Object.values(goals || {}).forEach(g => g.ex.forEach(e => { if (!seen[e[0]]) { seen[e[0]] = 1; out.push(e); } })); EXTRA.forEach(e => { if (!seen[e[0]]) { seen[e[0]] = 1; out.push(e); } }); return out; };

  /* ---------- усталость по мышцам ---------- */
  function fatigue(done) { const F = {}; done.forEach(ex => { const m = metaOf(ex); F[m.m] = (F[m.m] || 0) + m.f * (ex[2] >= 3 ? 1 : 0.5); }); return F; }
  const dm = (ctx, w) => (w && w.x != null && ctx.pos ? Math.hypot(w.x - ctx.pos.x, w.y - ctx.pos.y) * (ctx.mPerUnit || 0.1) : 0);
  const limited = (m, ctx) => (ctx.limits || []).some(l => m.st.indexOf(l) >= 0);

  /* ---------- допустима ли перестановка: step j встаёт на место i ---------- */
  function reorderAllowed(steps, i, j, fat, ctx) {
    const q = steps[j], qm = metaOf(q.ex);
    if (limited(qm, ctx)) return false;
    // сначала базовые упражнения на мышцу, потом изоляция
    if (qm.cls === 'iso') for (let k = i; k < j; k++) { const m = metaOf(steps[k].ex); if (m.m === qm.m && m.cls === 'compound') return false; }
    // разминка и кардио не уезжают вперёд тяжёлой работы
    if (qm.cls === 'cardio' && steps.slice(i, j).some(s => metaOf(s.ex).cls === 'compound')) return false;
    // не ставим подряд тяжёлую работу на одну уже уставшую мышцу
    if ((fat[qm.m] || 0) >= 5 && qm.cls === 'compound') return false;
    return true;
  }

  /* ---------- оценка маршрута ---------- */
  // steps: [{ex:[название,тип,подходов]}], i — индекс упражнения, которое пора начинать
  // ctx: { wait(type) → { w, id, x, y }, pos:{x,y}, limits:[], goals, mPerUnit, threshold }
  function evaluate(steps, i, ctx) {
    const cur = steps[i]; if (!cur) return null;
    const cm = metaOf(cur.ex); if (cm.cls === 'cooldown') return null;
    const w0 = ctx.wait(cur.ex[1]), TH = ctx.threshold == null ? 3 : ctx.threshold;
    if (w0.w < TH) return null;
    const fat = fatigue(steps.slice(0, i).map(s => s.ex)), cands = [];
    // 1. перестановка с одним из следующих упражнений
    for (let j = i + 1; j < steps.length; j++) {
      const q = steps[j], qm = metaOf(q.ex); if (qm.cls === 'cooldown') continue;
      const wq = ctx.wait(q.ex[1]); if (wq.w > 1) continue;
      if (!reorderAllowed(steps, i, j, fat, ctx)) continue;
      const d = dm(ctx, wq);
      cands.push({ type: 'reorder', j, to: q.ex, unit: wq, wait: wq.w, distM: d, score: 16 - wq.w * 3 - d / 8 - (j - i) * 0.6 }); // перестановка предпочтительнее замены: ничего не теряем
    }
    // 2. замена на эквивалент
    const planned = new Set(steps.map(s => s.ex[0])), doneNames = new Set(steps.slice(0, i).map(s => s.ex[0]));
    catalog(ctx.goals).forEach(e => {
      if (planned.has(e[0]) || doneNames.has(e[0]) || e[1] === cur.ex[1]) return;
      const m = metaOf(e); if (m.m !== cm.m || cm.cls === 'cardio' || limited(m, ctx)) return;
      if (m.f > cm.f) return; // не тяжелее исходного
      const fm = fat[cm.m] || 0;
      if (fm >= 4 && m.cls !== 'iso') return; // мышца уже устала — только лёгкая изоляция
      if (cm.cls === 'compound' && m.cls === 'iso' && fm < 2 && w0.w < 5) return; // базовое на изоляцию меняем при очереди от 5 минут или после нагрузки
      const w = ctx.wait(e[1]); if (w.w > Math.max(1, w0.w - 3)) return;
      const d = dm(ctx, w);
      cands.push({ type: 'sub', to: [e[0], e[1], cur.ex[2]], unit: w, wait: w.w, distM: d, score: 6 - w.w * 3 - d / 8 + (m.pat === cm.pat ? 3 : 0) + (m.cls === cm.cls ? 2 : 0) - Math.abs(m.f - cm.f) });
    });
    if (!cands.length) return { type: 'wait', index: i, from: cur.ex, waitBefore: w0.w, text: 'Подходящей замены сейчас нет — лучше подождать или сделать подход к лёгкой растяжке.' };
    cands.sort((a, b) => b.score - a.score);
    const c = cands[0], m = metaOf(c.to);
    return Object.assign({ index: i, from: cur.ex, waitBefore: w0.w, waitAfter: c.wait, muscle: cm.m, sameMuscle: m.m === cm.m, why: reasonOf(c, cm, m, fat) }, c);
  }
  function reasonOf(c, cm, m, fat) {
    const r = [];
    if (c.type === 'reorder') r.push('Программа сохранена: меняем порядок, ничего не пропускаем');
    else r.push('Нагружает ту же группу мышц');
    if (c.type === 'sub' && m.pat === cm.pat) r.push('то же движение');
    if ((fat[cm.m] || 0) >= 4) r.push('мышца уже устала — взято более лёгкое упражнение');
    return r.join(' · ');
  }

  /* ---------- применение и возврат ---------- */
  function apply(steps, res) {
    if (!res || res.type === 'wait') return steps;
    if (res.type === 'reorder') { const q = steps.splice(res.j, 1)[0]; steps.splice(res.index, 0, q); return steps; }
    if (res.type === 'sub') { const s = steps[res.index]; s.orig = s.orig || s.ex; s.ex = res.to; s.subbedAt = Date.now(); return steps; }
    return steps;
  }
  // освободился оригинал, а заменённое упражнение ещё не начато → вернуть
  function checkReturn(steps, i, ctx) {
    for (let k = i; k < steps.length; k++) {
      const s = steps[k]; if (!s.orig) continue;
      const w = ctx.wait(s.orig[1]); if (w.w > 1) continue;
      const m = metaOf(s.orig), fat = fatigue(steps.slice(0, k).map(x => x.ex));
      if (limited(m, ctx) || ((fat[m.m] || 0) >= 5 && m.cls === 'compound')) continue;
      return { type: 'return', index: k, from: s.ex, to: s.orig, unit: w, distM: dm(ctx, w), waitAfter: w.w, why: 'Тренажёр освободился — возвращаем упражнение из вашей программы' };
    }
    return null;
  }
  function applyReturn(steps, res) { const s = steps[res.index]; s.ex = res.to; delete s.orig; return steps; }

  const tr = { reorder: 'Порядок изменён', sub: 'Упражнение заменено', return: 'Упражнение возвращено в маршрут' };
  AI.Routing = { evaluate, apply, checkReturn, applyReturn, metaOf, fatigue, catalog, EXM, titles: tr, LIMITS: { knee: 'Колени', back: 'Поясница', shoulder: 'Плечи' } };
})(typeof window !== 'undefined' ? window : globalThis);
