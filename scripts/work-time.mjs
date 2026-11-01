// Ход работы во времени (README, docs/PROGRESS.md; ROADMAP S10, issue #112) по журналам Claude Code.
// Из журнала берутся только метка времени, ветка git, идентификатор и название сессии и модель.
//
// Активное время — сумма промежутков между соседними сообщениями (user или assistant) всех сессий
// вместе, если промежуток не больше порога (5, 15 и 30 минут). Этап — по ветке `feature/sN-…`;
// сообщения на main внутри сессии этапа (план до создания ветки) — к ближайшему этапу этой сессии;
// сессия без ветки этапа — по коду в названии («PRE: …», «… S6»).
//
// node scripts/work-time.mjs <каталог журналов Claude Code>
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/work-time.mjs <logs dir>');
  process.exit(2);
}
const TZ_SHIFT = 6 * 3600e3; // Asia/Bishkek, без перехода на летнее время
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
const events = [];
const customTitles = new Map();
const aiTitles = new Map();
const models = new Map();

for (const f of files) {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, f)), crlfDelay: Infinity });
  for await (const line of rl) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'custom-title') customTitles.set(e.sessionId, e.customTitle);
    if (e.type === 'ai-title') aiTitles.set(e.sessionId, e.aiTitle);
    if ((e.type !== 'user' && e.type !== 'assistant') || !e.timestamp) continue;
    const model = e.message?.model;
    if (e.type === 'assistant' && model && !model.startsWith('<') && e.message.id) {
      if (!models.has(model)) models.set(model, new Set());
      models.get(model).add(e.message.id);
    }
    events.push({ t: Date.parse(e.timestamp), sid: e.sessionId, branch: e.gitBranch ?? '' });
  }
}
events.sort((a, b) => a.t - b.t);
const title = (sid) => customTitles.get(sid) ?? aiTitles.get(sid) ?? '';

const branchStage = (b) => {
  const m = /(?:^|[/-])s(\d+)\b/i.exec(b);
  return m ? 'S' + m[1] : null;
};

const assigned = new Map();
const bySid = new Map();
for (const e of events) {
  if (!bySid.has(e.sid)) bySid.set(e.sid, []);
  bySid.get(e.sid).push(e);
}
for (const [sid, list] of bySid) {
  const t = title(sid);
  const fromTitle = t.startsWith('PRE') ? 'PRE' : /\bS(\d+)\b/.test(t) ? 'S' + /\bS(\d+)\b/.exec(t)[1] : null;
  let next = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const s = branchStage(list[i].branch);
    if (s) next = s;
    else if (next) assigned.set(list[i], next);
  }
  let prev = null;
  for (const e of list) {
    const s = branchStage(e.branch);
    if (s) prev = s;
    else if (!assigned.has(e)) assigned.set(e, prev ?? fromTitle ?? 'вне этапов');
  }
}
const stageOf = (e) => (title(e.sid).startsWith('PRE') ? 'PRE' : (branchStage(e.branch) ?? assigned.get(e)));

const day = (t) => new Date(t + TZ_SHIFT).toISOString().slice(0, 10);
const hours = (ms) => (ms / 3600e3).toFixed(1).replace('.', ',');

for (const cap of [5, 15, 30]) {
  const byStage = new Map();
  const byDay = new Map();
  let total = 0;
  for (let i = 1; i < events.length; i++) {
    const gap = events[i].t - events[i - 1].t;
    if (gap <= 0 || gap > cap * 60e3) continue;
    total += gap;
    const s = stageOf(events[i]);
    byStage.set(s, (byStage.get(s) ?? 0) + gap);
    const d = day(events[i].t);
    byDay.set(d, (byDay.get(d) ?? 0) + gap);
  }
  console.log(`\nПорог ${cap} мин: всего ${hours(total)} ч`);
  if (cap !== 15) continue;
  const order = ['PRE', ...Array.from({ length: 11 }, (_, i) => 'S' + i), 'вне этапов'];
  console.log('\n| Этап | Часов |\n|---|---|');
  for (const s of order) if (byStage.has(s)) console.log(`| ${s} | ${hours(byStage.get(s))} |`);
  console.log('\n| Дата | Часов |\n|---|---|');
  for (const [d, ms] of [...byDay].sort()) console.log(`| ${d} | ${hours(ms)} |`);
}

const fmt = (t) => new Date(t + TZ_SHIFT).toISOString().slice(0, 16).replace('T', ' ');
console.log(`\nСессий: ${bySid.size}, сообщений: ${events.length}, первое ${fmt(events[0].t)}, последнее ${fmt(events.at(-1).t)} (Бишкек)`);
const answers = [...models].map(([m, ids]) => [m, ids.size]);
const sum = answers.reduce((s, [, n]) => s + n, 0);
for (const [m, n] of answers) console.log(`${m}: ${n} ответов (${Math.round((n / sum) * 100)}%)`);
