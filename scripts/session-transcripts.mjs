// Стенограммы сессий Claude Code для docs/sessions (ROADMAP S10, issue #112).
// Из журнала JSONL берутся промпты пользователя и текст ответов агента; вызовы
// инструментов — одной строкой (инструмент и цель), их вывод и рассуждения модели не берутся.
// Пути с именем пользователя Windows, email и JWT заменяются заглушками.
//
// node scripts/session-transcripts.mjs <каталог журналов> <каталог вывода> [--exclude id,id] [--featured id,id]
// id — первые 8 символов идентификатора сессии (имя файла журнала).
import fs from 'node:fs';
import path from 'node:path';

const [, , srcDir, outDir, ...rest] = process.argv;
if (!srcDir || !outDir) {
  console.error('usage: node scripts/session-transcripts.mjs <logs dir> <out dir> [--exclude id,id] [--featured id,id]');
  process.exit(2);
}
const option = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const excludeArg = option('--exclude');
const featuredArg = option('--featured');
const exclude = new Set(excludeArg ? excludeArg.split(',') : []);
const TZ_SHIFT = 6 * 3600e3; // Asia/Bishkek, без перехода на летнее время

const local = (iso) => new Date(Date.parse(iso) + TZ_SHIFT).toISOString();
const hhmm = (iso) => local(iso).slice(11, 16);

export function sanitize(text) {
  return text
    .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`]+/gi, '~')
    .replace(/\/[a-z]\/Users\/[^/\s"'`]+/gi, '~')
    .replace(/[a-z]--Users-[A-Za-z0-9]+-/gi, '~-')
    .replace(/~[\\/](?:[^\\/\s"'`]+[\\/])*?leave-management-system(?:[\\/]|\b)/g, '')
    .replace(/\bPOiB\b/g, '<user>')
    .replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, '<jwt>')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, (m) =>
      /@(vacation\.local|example\.(com|org)|anthropic\.com)$/i.test(m) ? m : '<email>',
    );
}

// Служебные вставки клиента (напоминания, открытый файл, выделение) в стенограмму не идут.
const stripNoise = (text) =>
  text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ide_(opened_file|selection)>[\s\S]*?<\/ide_\1>/g, '')
    .replace(/<local-command-(stdout|caveat)>[\s\S]*?<\/local-command-\1>/g, '')
    .trim();

const toolTarget = (name, input = {}) => {
  const v =
    input.file_path ?? input.path ?? input.pattern ?? input.description ?? input.skill ?? input.url ?? input.query ?? '';
  return `\`${name}\`${v ? ': ' + String(v).split('\n')[0].slice(0, 140) : ''}`;
};

const stageOf = (branch) => {
  const m = /(?:^|[/-])s(\d+)\b/i.exec(branch ?? '');
  return m ? 'S' + m[1] : null;
};

function readSession(file) {
  const events = [];
  let customTitle = '';
  let aiTitle = '';
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'custom-title') customTitle = e.customTitle;
    if (e.type === 'ai-title') aiTitle = e.aiTitle;
    if ((e.type === 'user' || e.type === 'assistant') && e.timestamp) events.push(e);
  }
  return { events, title: customTitle || aiTitle || '' };
}

function render({ events, title }, id) {
  const branches = [...new Set(events.map((e) => e.gitBranch).filter(Boolean))];
  const models = [...new Set(events.map((e) => e.message?.model).filter((m) => m && !m.startsWith('<')))];
  // Этап — по ветке; сессия на main без ветки этапа — по коду в названии («Слепой аудит этапа S6»).
  const titleStage = /\bS(\d+)\b/.exec(title);
  const stage = title.startsWith('PRE')
    ? 'PRE'
    : (branches.map(stageOf).find(Boolean) ?? (titleStage ? 'S' + titleStage[1] : 'вне этапов'));
  const out = [
    `# ${title || 'Сессия без названия'}`,
    '',
    `- Сессия: \`${id}\``,
    `- Время (Бишкек): ${local(events[0].timestamp).slice(0, 16).replace('T', ' ')} – ${local(events.at(-1).timestamp).slice(0, 16).replace('T', ' ')}`,
    `- Этап: ${stage}; ветки: ${branches.join(', ') || '—'}`,
    `- Модели: ${models.join(', ') || '—'}`,
    '',
    '> Стенограмма из журнала Claude Code: промпты и ответы агента полностью, действия агента — одной строкой, без вывода инструментов и рассуждений модели. Пути, email и токены заменены заглушками.',
    '',
  ];
  let tools = [];
  const flushTools = () => {
    if (tools.length) out.push('<details><summary>Действия агента: ' + tools.length + '</summary>', '', ...tools.map((t) => '- ' + t), '', '</details>', '');
    tools = [];
  };
  let lastSpeaker = '';
  let prompts = 0;
  for (const e of events) {
    const c = e.message?.content;
    if (e.type === 'user') {
      if (e.isMeta || e.isCompactSummary) continue;
      const text = typeof c === 'string' ? c : (c ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
      const clean = stripNoise(text);
      if (!clean || clean.startsWith('<command-')) continue;
      flushTools();
      out.push(`## Пользователь · ${hhmm(e.timestamp)}`, '', clean, '');
      lastSpeaker = 'user';
      prompts++;
    } else {
      for (const b of Array.isArray(c) ? c : []) {
        if (b.type === 'tool_use') tools.push(toolTarget(b.name, b.input));
        if (b.type === 'text' && b.text.trim()) {
          flushTools();
          if (lastSpeaker !== 'assistant') out.push(`## Агент · ${hhmm(e.timestamp)}`, '');
          out.push(b.text.trim(), '');
          lastSpeaker = 'assistant';
        }
      }
    }
  }
  flushTools();
  return { md: sanitize(out.join('\n')), stage, prompts, branches };
}

const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.jsonl'));
fs.mkdirSync(outDir, { recursive: true });
const index = [];
for (const f of files) {
  const id = f.slice(0, 8);
  if (exclude.has(id)) continue;
  const session = readSession(path.join(srcDir, f));
  if (!session.events.length) continue;
  const { md, stage, prompts } = render(session, id);
  if (!prompts) continue;
  const start = local(session.events[0].timestamp);
  const name = `${start.slice(0, 10)}-${start.slice(11, 16).replace(':', '')}-${stage.toLowerCase().replace(/\s/g, '-')}-${id}.md`;
  fs.writeFileSync(path.join(outDir, name), md);
  index.push({ name, start, stage, title: sanitize(session.title), prompts });
}
index.sort((a, b) => (a.start < b.start ? -1 : 1));
const featured = new Set(featuredArg ? featuredArg.split(',') : []);
const row = (r) =>
  `| ${r.start.slice(0, 16).replace('T', ' ')} | ${r.stage} | [${r.title.replace(/\|/g, '\\|') || 'без названия'}](${r.name}) | ${r.prompts} |`;
const head = ['| Начало (Бишкек) | Этап | Сессия | Промптов |', '|---|---|---|---|'];
const md = [
  '# Сессии Claude Code',
  '',
  `Стенограммы ${index.length} сессий работы с агентом, по времени. Получены скриптом [scripts/session-transcripts.mjs](../../scripts/session-transcripts.mjs) из журналов Claude Code (JSONL): промпты и ответы агента полностью, действия агента (вызовы инструментов) — одной строкой, без вывода инструментов и рассуждений модели. Пути с именем пользователя, email и токены заменены заглушками. Исходные JSONL-журналы (${files.length} файлов, около ${Math.round(files.reduce((s, f) => s + fs.statSync(path.join(srcDir, f)).size, 0) / 1e6)} МБ) в репозиторий не положены из-за объёма. Не включены ${exclude.size} короткие сессии, не относящиеся к работе над проектом.`,
  '',
  ...(featured.size
    ? ['## С чего начать', '', ...head, ...index.filter((r) => featured.has(r.name.slice(-11, -3))).map(row), '']
    : []),
  '## Все сессии',
  '',
  ...head,
  ...index.map(row),
  '',
];
fs.writeFileSync(path.join(outDir, 'INDEX.md'), md.join('\n'));
console.log(`стенограмм: ${index.length}`);
