// Прослеживаемость RULES -> тесты (ROADMAP, раздел 0).
// Собирает ссылки `// RULES §N` и `// RULES §N-k` из *.spec.ts и падает на несуществующих.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);

/** Разделы RULES: номер -> число пунктов верхнего уровня («- » в начале строки). */
export function parseRules(text) {
  const sections = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^##\s+(\d+)\./.exec(line);
    if (h) {
      current = Number(h[1]);
      sections.set(current, 0);
    } else if (current !== null && line.startsWith('- ')) {
      sections.set(current, sections.get(current) + 1);
    }
  }
  return sections;
}

export function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.spec.ts')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** Ссылки из комментариев `// RULES §3, §4-2`. */
export function extractRefs(source) {
  const refs = [];
  source.split(/\r?\n/).forEach((line, i) => {
    const m = /\/\/\s*RULES\s+(.*)$/.exec(line);
    if (!m) return;
    for (const r of m[1].matchAll(/§(\d+)(?:-(\d+))?/g)) {
      refs.push({ section: Number(r[1]), item: r[2] ? Number(r[2]) : null, line: i + 1 });
    }
  });
  return refs;
}

export function trace({ rulesPath, rootDir }) {
  const sections = parseRules(fs.readFileSync(rulesPath, 'utf8'));
  const table = new Map(); // "§N" или "§N-k" -> Set(file:line)
  const errors = [];
  for (const file of walk(rootDir)) {
    const rel = path.relative(rootDir, file).split(path.sep).join('/');
    for (const ref of extractRefs(fs.readFileSync(file, 'utf8'))) {
      const id = ref.item === null ? `§${ref.section}` : `§${ref.section}-${ref.item}`;
      const where = `${rel}:${ref.line}`;
      if (!sections.has(ref.section)) {
        errors.push(`${where}: нет раздела ${id} в RULES`);
      } else if (ref.item !== null && (ref.item < 1 || ref.item > sections.get(ref.section))) {
        errors.push(`${where}: нет пункта ${id} в RULES (в разделе ${sections.get(ref.section)} пунктов)`);
      } else {
        if (!table.has(id)) table.set(id, new Set());
        table.get(id).add(where);
      }
    }
  }
  return { table, errors };
}

export function formatTable(table) {
  const rows = [...table.entries()].sort(([a], [b]) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  return ['| Утверждение | Тесты |', '|---|---|', ...rows.map(([id, w]) => `| ${id} | ${[...w].join(', ')} |`)].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { table, errors } = trace({ rulesPath: path.join(rootDir, 'docs', 'RULES.md'), rootDir });
  console.log(formatTable(table));
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
}
