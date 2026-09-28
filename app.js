'use strict';

// Everything is stored in this browser's localStorage, on this device only.
const STORE_KEY = 'healthlog.v1';
const SEV_LABELS = ['None', 'Mild', 'Moderate', 'Severe'];
const FLOWS = ['Spotting', 'Light', 'Medium', 'Heavy'];
const BACKUP_EVERY_DAYS = 14;

// Generic starting point. Personal symptom lists are loaded from a private setup file
// (Settings → Restore from backup) so they never live in this public code.
const DEFAULT_SYMPTOMS = [
  { id: 'fatigue', name: 'Fatigue', tier: 'daily' },
  { id: 'headache', name: 'Headache', tier: 'library' },
  { id: 'nausea', name: 'Nausea', tier: 'library' },
];

const DEFAULT_TRIGGERS = [
  { id: 'stress', name: 'Stress' },
  { id: 'badsleep', name: 'Bad sleep' },
];

const DEFAULT_STANDING_NOTES = '';

// ---------- storage ----------

function freshDb() {
  return {
    version: 1,
    symptoms: DEFAULT_SYMPTOMS.map((s) => ({ ...s })),
    triggers: DEFAULT_TRIGGERS.map((t) => ({ ...t })),
    entries: {},
    standingNotes: DEFAULT_STANDING_NOTES,
    lastBackup: null,
  };
}

function migrate(d) {
  const base = freshDb();
  return {
    version: 1,
    symptoms: Array.isArray(d.symptoms) ? d.symptoms : base.symptoms,
    triggers: Array.isArray(d.triggers) ? d.triggers : base.triggers,
    entries: d.entries && typeof d.entries === 'object' ? d.entries : {},
    standingNotes: typeof d.standingNotes === 'string' ? d.standingNotes : base.standingNotes,
    lastBackup: d.lastBackup || null,
    restored: !!d.restored,
  };
}

let storageOk = true;
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch (err) {
    console.error(err);
    storageOk = false;
  }
  return freshDb();
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
    storageOk = true;
    toast('Saved');
  } catch (err) {
    console.error(err);
    storageOk = false;
    toast("Couldn't save!");
  }
}

let db = load();
const state = { view: 'today', date: todayKey(), range: 30, showLibrary: false, renaming: null, editingOptions: null };

// ---------- helpers ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && !k.includes('-')) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function keyOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(k, n) {
  const d = parseKey(k);
  d.setDate(d.getDate() + n);
  return keyOf(d);
}
function todayKey() { return keyOf(new Date()); }
function daysBetween(a, b) { return Math.round((parseKey(b) - parseKey(a)) / 86400000); }
function fmtDate(k, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return parseKey(k).toLocaleDateString(undefined, opts);
}
function dateRange(start, end) {
  const out = [];
  for (let k = start; k <= end; k = addDays(k, 1)) out.push(k);
  return out;
}
function round1(n) { return Math.round(n * 10) / 10; }
function avg(nums) { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null; }
function symById(id) { return db.symptoms.find((s) => s.id === id); }
function slug(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
  return `${base}-${Date.now().toString(36)}`;
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 900);
}

function isEmptyEntry(e) {
  return e.sleepHours == null && e.rested == null && e.energy == null && e.pain == null && e.mood == null &&
    !Object.keys(e.symptoms || {}).length && !(e.triggers || []).length && !e.period &&
    e.bpSys == null && e.bpDia == null && e.hr == null && !(e.notes || '').trim();
}

function editEntry(date, fn) {
  const e = db.entries[date] || { symptoms: {}, triggers: [] };
  e.symptoms = e.symptoms || {};
  e.triggers = e.triggers || [];
  fn(e);
  if (isEmptyEntry(e)) delete db.entries[date];
  else db.entries[date] = e;
  save();
}

function setField(field, value) {
  editEntry(state.date, (e) => {
    if (value == null || value === '' || Number.isNaN(value)) delete e[field];
    else e[field] = value;
  });
}

// Day of the current cycle (day 1 = first day of the most recent period on or before `date`).
function cycleDay(date) {
  let k = date;
  for (let i = 0; i < 60 && !db.entries[k]?.period; i++) k = addDays(k, -1);
  if (!db.entries[k]?.period) return null;
  while (db.entries[addDays(k, -1)]?.period) k = addDays(k, -1);
  return daysBetween(k, date) + 1;
}

function periodStarts() {
  return Object.keys(db.entries).sort()
    .filter((k) => db.entries[k].period && !db.entries[addDays(k, -1)]?.period);
}

// The answers to "when did your last period start?" and "how long are your cycles?", as of `date`.
function cycleFacts(date) {
  const starts = periodStarts().filter((k) => k <= date);
  if (!starts.length) return null;
  const last = starts[starts.length - 1];
  const ago = daysBetween(last, date);
  const lengths = starts.slice(1).map((k, i) => daysBetween(starts[i], k)).slice(-6);
  const avgLen = lengths.length ? Math.round(avg(lengths)) : null;
  return h('div', { style: 'margin-bottom:10px' },
    h('p', null, h('b', null, 'Last period started: '),
      fmtDate(last, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' }),
      h('span', { class: 'muted' }, ago === 0 ? ' (today)' : ago === 1 ? ' (yesterday)' : ` (${ago} days ago)`)),
    avgLen && h('p', { class: 'muted' },
      `Cycles average ${avgLen} days · next expected around ${fmtDate(addDays(last, avgLen), { month: 'short', day: 'numeric' })}`));
}

function backupDue() {
  if (Object.keys(db.entries).length < 3) return false;
  if (!db.lastBackup) return true;
  return (Date.now() - new Date(db.lastBackup).getTime()) / 86400000 >= BACKUP_EVERY_DAYS;
}

// ---------- controls ----------

// Tap to select; tap the selected option again to clear it.
function segmented(options, value, onChange) {
  const wrap = h('div', { class: 'seg', role: 'group' });
  for (const opt of options) {
    const b = h('button', {
      type: 'button', class: 'seg-btn', 'aria-pressed': String(opt.value === value),
      onclick: () => {
        const next = b.getAttribute('aria-pressed') === 'true' ? null : opt.value;
        wrap.querySelectorAll('.seg-btn').forEach((x) => x.setAttribute('aria-pressed', String(next !== null && x === b)));
        onChange(next);
      },
    }, opt.label);
    wrap.append(b);
  }
  return wrap;
}

function rating(field, value, [lo, hi]) {
  return h('div', null,
    segmented([1, 2, 3, 4, 5].map((n) => ({ label: String(n), value: n })), value ?? null, (v) => setField(field, v)),
    h('div', { class: 'hints' }, h('span', null, `1 = ${lo}`), h('span', null, `5 = ${hi}`)));
}

function numberInput(value, onValue, attrs = {}) {
  return h('input', {
    type: 'number', inputMode: 'decimal', value: value ?? '', ...attrs,
    oninput: (ev) => onValue(ev.target.value === '' ? null : Number(ev.target.value)),
  });
}

function card(title, ...body) {
  return h('section', { class: 'card' }, title && h('h2', null, title), ...body);
}

function field(label, control) {
  return h('div', { class: 'field' }, h('span', { class: 'label' }, label), control);
}

// ---------- Today ----------

function symptomRow(s, rec, removable) {
  const date = state.date;
  const levels = removable ? [1, 2, 3] : [0, 1, 2, 3];
  const row = h('div', { class: 'sym' },
    h('div', { class: 'sym-head' },
      h('span', { class: 'sym-name' }, s.name),
      removable && h('button', {
        type: 'button', class: 'link-btn',
        onclick: () => { editEntry(date, (e) => { delete e.symptoms[s.id]; }); render(); },
      }, 'Remove')),
    segmented(levels.map((i) => ({ label: SEV_LABELS[i], value: i })), rec?.sev ?? null, (v) => {
      editEntry(date, (e) => {
        if (v == null) delete e.symptoms[s.id];
        else e.symptoms[s.id] = { ...(e.symptoms[s.id] || {}), sev: v };
      });
      if (removable && v == null) render();
    }));
  if (s.contexts) {
    const chosen = rec?.ctx || [];
    row.append(h('div', { class: 'chips' }, s.contexts.map((c) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(chosen.includes(c)),
      onclick: () => {
        editEntry(date, (e) => {
          const r = e.symptoms[s.id] || { sev: 1 };
          const ctx = new Set(r.ctx || []);
          ctx.has(c) ? ctx.delete(c) : ctx.add(c);
          r.ctx = [...ctx];
          e.symptoms[s.id] = r;
        });
        render();
      },
    }, c))));
  }
  return row;
}

function libraryPanel(e) {
  const logged = new Set(Object.keys(e.symptoms || {}));
  const options = db.symptoms.filter((s) => s.tier === 'library' && !logged.has(s.id));
  const input = h('input', { type: 'text', placeholder: 'New symptom…', 'aria-label': 'New symptom name' });
  const addNew = () => {
    const name = input.value.trim();
    if (!name) return;
    const s = { id: slug(name), name, tier: 'library' };
    db.symptoms.push(s);
    editEntry(state.date, (en) => { en.symptoms[s.id] = { sev: 1 }; });
    render();
  };
  return h('div', { class: 'field' },
    options.length
      ? h('div', { class: 'chips' }, options.map((s) => h('button', {
          type: 'button', class: 'chip',
          onclick: () => { editEntry(state.date, (en) => { en.symptoms[s.id] = { sev: 1 }; }); render(); },
        }, `+ ${s.name}`)))
      : h('p', { class: 'muted' }, 'Everything in your library is already logged today.'),
    h('div', { class: 'row', style: 'margin-top:10px' },
      input,
      h('button', { type: 'button', class: 'btn secondary', onclick: addNew }, 'Add')),
    h('p', { class: 'muted', style: 'margin-top:6px' }, 'New symptoms join your library, so next time they’re one tap away.'));
}

function renderToday() {
  const date = state.date;
  const e = db.entries[date] || { symptoms: {}, triggers: [] };
  const isToday = date === todayKey();
  const cd = cycleDay(date);
  const daily = db.symptoms.filter((s) => s.tier === 'daily');
  const extras = Object.keys(e.symptoms || {}).map(symById).filter((s) => s && s.tier !== 'daily');
  const go = (n) => { state.date = addDays(date, n); state.showLibrary = false; render(); };

  return h('div', null,
    Object.keys(db.entries).length === 0 && !db.lastBackup && !db.restored && h('div', { class: 'banner' },
      h('span', null, 'New here? If you have a setup or backup file, load it first.'),
      h('button', { type: 'button', class: 'btn', onclick: () => { state.view = 'settings'; render(); } }, 'Go to Settings')),
    !storageOk && h('div', { class: 'banner' }, 'This browser is blocking storage, so entries can’t be saved. Check that you’re not in a private tab.'),
    backupDue() && h('div', { class: 'banner' },
      h('span', null, db.lastBackup ? `Last backup: ${fmtDate(keyOf(new Date(db.lastBackup)))}. Time for a fresh one?` : 'You haven’t saved a backup yet.'),
      h('button', { type: 'button', class: 'btn', onclick: exportData }, 'Back up now')),

    h('div', { class: 'datebar' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous day', onclick: () => go(-1) }, '‹'),
      h('label', { class: 'date-label' },
        h('span', { class: 'date-main' }, isToday ? 'Today' : fmtDate(date, { weekday: 'long' })),
        h('span', { class: 'date-sub' }, fmtDate(date, { month: 'long', day: 'numeric', year: 'numeric' })),
        h('input', {
          type: 'date', class: 'date-input', value: date, max: todayKey(), 'aria-label': 'Pick a date',
          onchange: (ev) => { if (ev.target.value && ev.target.value <= todayKey()) { state.date = ev.target.value; render(); } },
        })),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next day', disabled: isToday, onclick: () => go(1) }, '›')),
    cd && h('p', { style: 'text-align:center' }, h('span', { class: 'chip-info' },
      `Cycle day ${cd} · started ${fmtDate(addDays(date, 1 - cd), { month: 'short', day: 'numeric' })}`)),

    card('Sleep',
      field('Hours slept last night', numberInput(e.sleepHours, (v) => setField('sleepHours', v), { class: 'hours', step: 0.5, min: 0, max: 24 })),
      field('How rested do you feel?', rating('rested', e.rested, ['Exhausted', 'Fully rested']))),

    card('How you feel',
      field('Energy', rating('energy', e.energy, ['None', 'Plenty'])),
      field('Overall pain', rating('pain', e.pain, ['Little or none', 'Worst'])),
      field('Mood', rating('mood', e.mood, ['Very low', 'Great']))),

    h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', null, 'Symptoms'),
        h('button', {
          type: 'button', class: 'link-btn',
          onclick: () => { state.showLibrary = !state.showLibrary; render(); },
        }, state.showLibrary ? 'Done' : '+ Add symptom')),
      state.showLibrary && libraryPanel(e),
      daily.map((s) => symptomRow(s, e.symptoms?.[s.id], false)),
      extras.map((s) => symptomRow(s, e.symptoms[s.id], true))),

    card('Triggers',
      h('p', { class: 'muted' }, 'Anything today that might have set things off?'),
      h('div', { class: 'chips' }, db.triggers.filter((t) => !t.archived).map((t) => {
        const on = (e.triggers || []).includes(t.id);
        return h('button', {
          type: 'button', class: 'chip', 'aria-pressed': String(on),
          onclick: (ev) => {
            const now = ev.currentTarget.getAttribute('aria-pressed') !== 'true';
            ev.currentTarget.setAttribute('aria-pressed', String(now));
            editEntry(date, (en) => {
              en.triggers = en.triggers.filter((x) => x !== t.id);
              if (now) en.triggers.push(t.id);
            });
          },
        }, t.name);
      }))),

    card('Cycle',
      cycleFacts(date),
      h('p', { class: 'muted' }, 'On your period today? Tap the flow. Tap again to clear.'),
      segmented(FLOWS.map((f) => ({ label: f, value: f })), e.period ?? null, (v) => { setField('period', v); render(); })),

    card('Blood pressure & heart rate',
      h('p', { class: 'muted' }, 'Optional, from your cuff.'),
      h('div', { class: 'vitals' },
        h('label', null, 'Systolic (top)', numberInput(e.bpSys, (v) => setField('bpSys', v), { inputMode: 'numeric', min: 50, max: 250 })),
        h('label', null, 'Diastolic (bottom)', numberInput(e.bpDia, (v) => setField('bpDia', v), { inputMode: 'numeric', min: 30, max: 160 })),
        h('label', null, 'Heart rate', numberInput(e.hr, (v) => setField('hr', v), { inputMode: 'numeric', min: 30, max: 220 })))),

    card('Notes',
      h('textarea', {
        value: e.notes || '', placeholder: 'Anything else: how the day went, something new, something you want to remember for the doctor…',
        'aria-label': 'Notes', oninput: (ev) => setField('notes', ev.target.value),
      })));
}

// ---------- History ----------

function entrySummary(e) {
  const syms = Object.entries(e.symptoms || {})
    .filter(([, r]) => r.sev > 0)
    .map(([id]) => symById(id)?.name || id);
  const bits = [];
  if (e.energy) bits.push(`Energy ${e.energy}/5`);
  if (e.mood) bits.push(`Mood ${e.mood}/5`);
  if (e.sleepHours != null) bits.push(`${e.sleepHours}h sleep`);
  if (syms.length) bits.push(syms.length > 3 ? `${syms.slice(0, 3).join(', ')} +${syms.length - 3}` : syms.join(', '));
  return bits.join(' · ') || (e.notes ? 'Notes only' : '');
}

function renderHistory() {
  const keys = Object.keys(db.entries).sort().reverse();
  return h('div', null,
    h('h1', null, 'History'),
    keys.length === 0
      ? card(null, h('p', null, 'Nothing logged yet.'), h('p', { class: 'muted' }, 'Your days will show up here once you start checking in.'))
      : keys.map((k) => {
          const e = db.entries[k];
          return h('button', {
            type: 'button', class: 'card hist',
            onclick: () => { state.date = k; state.view = 'today'; state.showLibrary = false; render(); window.scrollTo(0, 0); },
          },
            h('div', { class: 'hist-top' },
              h('span', null, fmtDate(k, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }), e.period && h('span', { class: 'dot', title: 'Period' })),
              e.triggers?.length ? h('span', { class: 'muted' }, e.triggers.map((id) => db.triggers.find((t) => t.id === id)?.name || id).join(', ')) : null),
            h('div', { class: 'muted' }, entrySummary(e)));
        }));
}

// ---------- Summary ----------

// null = unknown. A skipped daily symptom is unknown; a library symptom that wasn't added means it didn't happen.
function sevOn(date, id) {
  const e = db.entries[date];
  if (!e) return null;
  const sev = e.symptoms?.[id]?.sev;
  if (sev != null) return sev;
  return symById(id)?.tier === 'daily' ? null : 0;
}

function renderSummary() {
  const end = todayKey();
  const allKeys = Object.keys(db.entries).sort();
  const start = state.range === 'all' ? (allKeys[0] || end) : addDays(end, -(state.range - 1));
  const dates = dateRange(start, end);
  const logged = dates.filter((d) => db.entries[d]);
  const E = (d) => db.entries[d];

  const rangeBtns = h('div', { class: 'seg no-print', style: 'margin-bottom:12px' },
    [[14, '2 weeks'], [30, '30 days'], [90, '90 days'], ['all', 'All']].map(([v, label]) => h('button', {
      type: 'button', class: 'seg-btn', 'aria-pressed': String(state.range === v),
      onclick: () => { state.range = v; render(); },
    }, label)));

  const header = h('div', null,
    h('h1', null, 'Summary'),
    h('p', { class: 'muted' }, `${fmtDate(start, { month: 'short', day: 'numeric', year: 'numeric' })} – ${fmtDate(end, { month: 'short', day: 'numeric', year: 'numeric' })} · ${logged.length} of ${dates.length} days logged`),
    rangeBtns);

  if (!logged.length) {
    return h('div', null, header, card(null, h('p', null, 'No check-ins in this range yet.'), h('p', { class: 'muted' }, 'After a week or two of logging, patterns will start showing up here.')));
  }

  // Overview
  const num = (f) => logged.map((d) => E(d)[f]).filter((v) => typeof v === 'number');
  const stat = (label, values, suffix = '') => {
    const a = avg(values);
    return h('div', { class: 'stat' }, h('b', null, a == null ? '–' : `${round1(a)}${suffix}`), h('span', null, label));
  };
  const overview = card('Overview',
    h('div', { class: 'stats' },
      stat('Avg sleep', num('sleepHours'), 'h'),
      stat('Avg rested (1–5)', num('rested')),
      stat('Avg energy (1–5)', num('energy')),
      stat('Avg pain (1–5)', num('pain')),
      stat('Avg mood (1–5)', num('mood')),
      h('div', { class: 'stat' }, h('b', null, String(logged.filter((d) => E(d).period).length)), h('span', null, 'Period days'))));

  // Symptom counts
  const present = db.symptoms.filter((s) => logged.some((d) => sevOn(d, s.id) > 0));
  const symTable = card('Symptoms',
    present.length
      ? h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Symptom'), h('th', { class: 'num' }, 'Days'), h('th', { class: 'num' }, 'Avg severity'), h('th', { class: 'num' }, 'Severe days'))),
          h('tbody', null, present.map((s) => {
            const sevs = logged.map((d) => sevOn(d, s.id)).filter((v) => v > 0);
            const ctxCounts = {};
            for (const d of logged) {
              const r = E(d).symptoms?.[s.id];
              if (r?.sev > 0) for (const c of r.ctx || []) ctxCounts[c] = (ctxCounts[c] || 0) + 1;
            }
            const ctxLine = Object.entries(ctxCounts).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(' · ');
            return h('tr', null,
              h('td', null, s.name, ctxLine ? h('span', { class: 'muted', style: 'display:block' }, ctxLine) : null),
              h('td', { class: 'num' }, String(sevs.length)),
              h('td', { class: 'num' }, SEV_LABELS[Math.round(avg(sevs))] ),
              h('td', { class: 'num' }, String(sevs.filter((v) => v === 3).length)));
          })))
      : h('p', { class: 'muted' }, 'No symptoms logged in this range.'));

  // Heatmap
  const heatDates = dates.slice(-120);
  const cols = heatDates.length;
  const grid = h('div', { class: 'heat', style: `grid-template-columns: 110px repeat(${cols}, 12px)` });
  grid.append(h('span', { class: 'rl' }, ''));
  heatDates.forEach((d, i) => grid.append(h('span', { class: 'tick' }, i % 7 === 0 ? fmtDate(d, { month: 'numeric', day: 'numeric' }) : '')));
  for (const s of present) {
    grid.append(h('span', { class: 'rl', title: s.name }, s.name));
    for (const d of heatDates) {
      const v = sevOn(d, s.id);
      grid.append(h('span', { class: `c ${v == null ? 'nodata' : 'l' + v}`, title: `${fmtDate(d)}: ${v == null ? 'not logged' : SEV_LABELS[v]}` }));
    }
  }
  grid.append(h('span', { class: 'rl' }, 'Period'));
  for (const d of heatDates) {
    const p = E(d)?.period;
    grid.append(h('span', { class: `c ${!E(d) ? 'nodata' : p ? 'per' : 'l0'}`, title: `${fmtDate(d)}: ${p || (E(d) ? 'no' : 'not logged')}` }));
  }
  const heat = card('Day by day',
    h('div', { class: 'heat-wrap' }, grid),
    h('div', { class: 'legend' },
      h('span', null, h('i', { style: 'background:var(--lvl0)' }), 'None'),
      h('span', null, h('i', { style: 'background:var(--lvl1)' }), 'Mild'),
      h('span', null, h('i', { style: 'background:var(--lvl2)' }), 'Moderate'),
      h('span', null, h('i', { style: 'background:var(--lvl3)' }), 'Severe'),
      h('span', null, h('i', { style: 'background:var(--period)' }), 'Period'),
      h('span', null, h('i', { style: 'outline:1px dashed var(--line)' }), 'Not logged')));

  // Trigger patterns: compare days with a trigger (that day or the day before) to days without.
  const patterns = [];
  for (const t of db.triggers.filter((x) => !x.archived)) {
    const hit = (d) => (E(d)?.triggers || []).includes(t.id) || (E(addDays(d, -1))?.triggers || []).includes(t.id);
    const withT = logged.filter(hit);
    const without = logged.filter((d) => !hit(d));
    if (withT.length < 3 || without.length < 3) continue;
    for (const s of present) {
      const known = (d) => sevOn(d, s.id) != null;
      const withS = withT.filter(known), withoutS = without.filter(known);
      if (withS.length < 3 || withoutS.length < 3) continue;
      const a = avg(withS.map((d) => sevOn(d, s.id)));
      const b = avg(withoutS.map((d) => sevOn(d, s.id)));
      if (a - b >= 0.5) patterns.push({ t, what: s.name, a, b, n1: withS.length, n2: withoutS.length, scale: 'severity 0–3' });
    }
    const ew = withT.map((d) => E(d).energy).filter(Boolean);
    const eo = without.map((d) => E(d).energy).filter(Boolean);
    const ea = avg(ew), eb = avg(eo);
    if (ew.length >= 3 && eo.length >= 3 && eb - ea >= 0.5) patterns.push({ t, what: 'Energy (lower)', a: ea, b: eb, n1: ew.length, n2: eo.length, scale: 'energy 1–5' });
  }
  const patternCard = card('Possible trigger patterns',
    h('p', { class: 'muted' }, 'Compares days with a trigger (that day or the day before) against days without. These are hints to discuss, not proof.'),
    patterns.length
      ? patterns.map((p) => h('div', { class: 'pattern' },
          h('b', null, `${p.what} with ${p.t.name.toLowerCase()}`),
          h('div', { class: 'muted' }, `Avg ${round1(p.a)} with vs ${round1(p.b)} without (${p.scale}) · ${p.n1} vs ${p.n2} days`)))
      : h('p', null, 'Nothing stands out yet. Patterns need at least 3 days with and 3 days without a trigger.'));

  // Cycle
  const starts = periodStarts();
  const lengths = starts.slice(1).map((k, i) => daysBetween(starts[i], k));
  const cycleCard = card('Cycle',
    starts.length
      ? h('div', null,
          h('p', null, `Recent period start dates: ${starts.slice(-6).map((k) => fmtDate(k, { month: 'short', day: 'numeric' })).join(', ')}`),
          lengths.length
            ? h('p', null, `Cycle length: avg ${round1(avg(lengths))} days (range ${Math.min(...lengths)}–${Math.max(...lengths)})`)
            : h('p', { class: 'muted' }, 'Cycle length shows up after two logged periods.'))
      : h('p', { class: 'muted' }, 'No periods logged yet.'));

  // Vitals
  const bp = logged.filter((d) => E(d).bpSys && E(d).bpDia);
  const hr = num('hr');
  const vitalsCard = (bp.length || hr.length) && card('Blood pressure & heart rate',
    bp.length ? h('p', null, `BP avg ${Math.round(avg(bp.map((d) => E(d).bpSys)))}/${Math.round(avg(bp.map((d) => E(d).bpDia)))} over ${bp.length} readings (highest ${Math.max(...bp.map((d) => E(d).bpSys))}/${Math.max(...bp.map((d) => E(d).bpDia))})`) : null,
    hr.length ? h('p', null, `Heart rate avg ${Math.round(avg(hr))} (range ${Math.min(...hr)}–${Math.max(...hr)})`) : null);

  // All-time timeline
  const timeline = db.symptoms.map((s) => {
    const days = allKeys.filter((d) => (db.entries[d].symptoms?.[s.id]?.sev || 0) > 0);
    return { s, days };
  }).filter((x) => x.days.length).sort((a, b) => a.days[0].localeCompare(b.days[0]));
  const fmtLong = (k) => fmtDate(k, { month: 'short', day: 'numeric', year: 'numeric' });
  const timelineCard = card('Symptom timeline (all time)',
    timeline.length
      ? h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Symptom'), h('th', null, 'First'), h('th', null, 'Last'), h('th', { class: 'num' }, 'Days'))),
          h('tbody', null, timeline.map(({ s, days }) => h('tr', null,
            h('td', null, s.name, s.tier === 'retired' ? h('span', { class: 'muted' }, ' (retired)') : null),
            h('td', null, fmtLong(days[0])),
            h('td', null, fmtLong(days[days.length - 1])),
            h('td', { class: 'num' }, String(days.length))))))
      : h('p', { class: 'muted' }, 'Nothing yet.'));

  const standing = db.standingNotes.trim() && card('Background & history', h('p', { class: 'pre' }, db.standingNotes));

  const noted = logged.filter((d) => (E(d).notes || '').trim());
  const notesCard = noted.length && card('Notes',
    noted.slice().reverse().map((d) => h('div', { class: 'pattern' }, h('b', null, fmtDate(d)), h('p', { class: 'pre' }, E(d).notes))));

  return h('div', null, header, overview, symTable, heat, patternCard, cycleCard, vitalsCard, timelineCard, standing, notesCard,
    h('div', { class: 'row no-print' }, h('button', { type: 'button', class: 'btn', onclick: () => window.print() }, 'Print / save as PDF for the doctor')));
}

// ---------- Settings ----------

// Optional chips shown under a symptom on the Today screen (e.g. where it hurts, or when it happens).
function optionsRow(s) {
  const input = h('input', {
    type: 'text', value: (s.contexts || []).join(', '), placeholder: 'e.g. Morning, Evening',
    'aria-label': `Options for ${s.name}, separated by commas`,
  });
  const done = (keep) => {
    if (keep) {
      const list = [...new Set(input.value.split(',').map((x) => x.trim()).filter(Boolean))];
      if (list.length) s.contexts = list;
      else delete s.contexts;
      save();
    }
    state.editingOptions = null;
    render();
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') done(true);
    if (ev.key === 'Escape') done(false);
  });
  setTimeout(() => input.focus());
  return h('div', { class: 'set-row', style: 'flex-wrap:wrap' },
    h('span', { class: 'name', style: 'flex-basis:100%' }, s.name, h('span', { class: 'muted', style: 'display:block' }, 'Options to tap, separated by commas. Leave empty for none.')),
    input,
    h('button', { type: 'button', class: 'btn secondary', onclick: () => done(true) }, 'Save'),
    h('button', { type: 'button', class: 'link-btn', onclick: () => done(false) }, 'Cancel'));
}

function renameRow(s) {
  const input = h('input', { type: 'text', value: s.name, 'aria-label': `New name for ${s.name}` });
  const done = (keep) => {
    const name = input.value.trim();
    if (keep && name) { s.name = name; save(); }
    state.renaming = null;
    render();
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') done(true);
    if (ev.key === 'Escape') done(false);
  });
  setTimeout(() => { input.focus(); input.select(); });
  return h('div', { class: 'set-row' }, input,
    h('button', { type: 'button', class: 'btn secondary', onclick: () => done(true) }, 'Save'),
    h('button', { type: 'button', class: 'link-btn', onclick: () => done(false) }, 'Cancel'));
}

function renderSettings() {
  const tiers = [['daily', 'Daily screen'], ['library', 'Library'], ['retired', 'Retired']];
  const symGroup = (tier, label) => {
    const list = db.symptoms.filter((s) => s.tier === tier);
    return h('div', null,
      h('h3', null, label),
      list.length ? list.map((s) => state.renaming === s.id ? renameRow(s) : state.editingOptions === s.id ? optionsRow(s) : h('div', { class: 'set-row' },
        h('span', { class: 'name' }, s.name,
          s.contexts?.length ? h('span', { class: 'muted', style: 'display:block' }, s.contexts.join(' · ')) : null),
        h('button', {
          type: 'button', class: 'link-btn',
          onclick: () => { state.renaming = s.id; render(); },
        }, 'Rename'),
        h('button', {
          type: 'button', class: 'link-btn',
          onclick: () => { state.editingOptions = s.id; render(); },
        }, 'Options'),
        h('select', {
          'aria-label': `Where ${s.name} shows up`,
          onchange: (ev) => { s.tier = ev.target.value; save(); render(); },
        }, tiers.map(([v, l]) => h('option', { value: v, selected: s.tier === v }, l)))))
        : h('p', { class: 'muted' }, tier === 'retired' ? 'Symptoms that stopped. Their history stays in the summary.' : 'None.'));
  };

  const newSym = h('input', { type: 'text', placeholder: 'New symptom', 'aria-label': 'New symptom name' });
  const newTier = h('select', { 'aria-label': 'Where it shows up' }, tiers.slice(0, 2).map(([v, l]) => h('option', { value: v }, l)));
  const newTrig = h('input', { type: 'text', placeholder: 'New trigger', 'aria-label': 'New trigger name' });
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none', onchange: importData });

  return h('div', null,
    h('h1', null, 'Settings'),

    card('Symptoms',
      h('p', { class: 'muted' }, 'Daily screen = shows every check-in. Library = one tap away. Retired = stopped happening, but the history is kept.'),
      tiers.map(([v, l]) => symGroup(v, l)),
      h('div', { class: 'row', style: 'margin-top:12px' }, newSym, newTier,
        h('button', {
          type: 'button', class: 'btn secondary',
          onclick: () => {
            const name = newSym.value.trim();
            if (!name) return;
            db.symptoms.push({ id: slug(name), name, tier: newTier.value });
            save(); render();
          },
        }, 'Add'))),

    card('Triggers',
      db.triggers.filter((t) => !t.archived).map((t) => h('div', { class: 'set-row' },
        h('span', { class: 'name' }, t.name),
        h('button', {
          type: 'button', class: 'link-btn',
          onclick: () => { if (confirm(`Stop showing “${t.name}”? Past days keep it.`)) { t.archived = true; save(); render(); } },
        }, 'Remove'))),
      h('div', { class: 'row', style: 'margin-top:12px' }, newTrig,
        h('button', {
          type: 'button', class: 'btn secondary',
          onclick: () => {
            const name = newTrig.value.trim();
            if (!name) return;
            const old = db.triggers.find((t) => t.archived && t.name.toLowerCase() === name.toLowerCase());
            if (old) old.archived = false;
            else db.triggers.push({ id: slug(name), name });
            save(); render();
          },
        }, 'Add'))),

    card('Background & history',
      h('p', { class: 'muted' }, 'Standing facts for the doctor summary: things that aren’t day-to-day symptoms.'),
      h('textarea', { value: db.standingNotes, 'aria-label': 'Background and history', oninput: (ev) => { db.standingNotes = ev.target.value; save(); } })),

    card('Your data',
      h('p', null, 'Everything is stored only in this browser, on this phone. Nothing is sent anywhere.'),
      h('p', { class: 'muted' }, db.lastBackup ? `Last backup: ${new Date(db.lastBackup).toLocaleString()}` : 'No backup saved yet.'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: exportData }, 'Save backup'),
        h('button', { type: 'button', class: 'btn secondary', onclick: () => fileIn.click() }, 'Restore from backup'),
        fileIn),
      h('div', { class: 'row', style: 'margin-top:16px' },
        h('button', {
          type: 'button', class: 'btn danger',
          onclick: () => {
            if (!confirm('Delete ALL your logged data from this phone?')) return;
            if (!confirm('Are you sure? This can’t be undone unless you have a backup.')) return;
            db = freshDb(); save(); render();
          },
        }, 'Delete everything'))));
}

function exportData() {
  const payload = { app: 'health-log', version: 1, exportedAt: new Date().toISOString(), data: db };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `health-log-${todayKey()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  db.lastBackup = new Date().toISOString();
  save();
  render();
}

function importData(ev) {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      const d = parsed.data || parsed;
      if (!d.entries || !Array.isArray(d.symptoms)) throw new Error('Not a Health Log backup');
      const n = Object.keys(d.entries).length;
      if (!confirm(`Replace what’s on this phone with the backup (${n} days)?`)) return;
      db = migrate(d);
      db.restored = true;
      save();
      render();
    } catch (err) {
      alert(`That file couldn’t be read as a backup. (${err.message})`);
    }
  };
  reader.readAsText(file);
}

// ---------- shell ----------

const VIEWS = { today: renderToday, history: renderHistory, summary: renderSummary, settings: renderSettings };

function render() {
  document.getElementById('app').replaceChildren(VIEWS[state.view]());
  document.querySelectorAll('.tabbar button').forEach((b) => {
    if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}

document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => {
  state.view = b.dataset.view;
  if (state.view === 'today') state.date = todayKey();
  state.showLibrary = false;
  render();
  window.scrollTo(0, 0);
}));

// Coming back to the app on a new day should open that day.
let lastSeenDay = todayKey();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && todayKey() !== lastSeenDay) {
    if (state.view === 'today' && state.date === lastSeenDay) state.date = todayKey();
    lastSeenDay = todayKey();
    render();
  }
});

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline mode unavailable', err));

render();
