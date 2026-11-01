// Проверка относительных ссылок в документах для проверяющего (ROADMAP S10 «Тесты»: проверка ссылок; issue #112):
// файл существует, а якорь `#…` совпадает с заголовком целевого Markdown-файла (как их строит GitHub).
import fs from 'node:fs';
import path from 'node:path';

export const DOCS = ['README.md', 'docs/PROGRESS.md', 'docs/DEVELOPMENT.md', 'docs/sessions/INDEX.md'];

// Якорь заголовка по правилам GitHub: нижний регистр, без знаков препинания, пробел → «-», повтор → «-1», «-2».
export function anchors(markdown) {
  const seen = new Map();
  const out = new Set();
  let fence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    const m = !fence && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = m[1]
      .replace(/`/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

// Ссылки вида [текст](цель) вне блоков кода; внешние (http, mailto) не проверяются.
export function links(markdown) {
  const out = [];
  let fence = false;
  markdown.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) return;
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(/\]\(([^)\s]+)\)/g)) {
      if (!/^[a-z]+:/i.test(m[1])) out.push({ target: m[1], line: i + 1 });
    }
  });
  return out;
}

export function brokenLinks(rootDir, docs = DOCS) {
  const broken = [];
  for (const doc of docs) {
    const docPath = path.join(rootDir, doc);
    if (!fs.existsSync(docPath)) {
      broken.push(`${doc}: файла нет`);
      continue;
    }
    for (const { target, line } of links(fs.readFileSync(docPath, 'utf8'))) {
      const [file, hash] = target.split('#');
      const targetPath = file ? path.resolve(path.dirname(docPath), decodeURIComponent(file)) : docPath;
      if (!fs.existsSync(targetPath)) {
        broken.push(`${doc}:${line}: нет файла ${target}`);
      } else if (hash && targetPath.endsWith('.md') && !anchors(fs.readFileSync(targetPath, 'utf8')).has(decodeURIComponent(hash))) {
        broken.push(`${doc}:${line}: нет заголовка ${target}`);
      }
    }
  }
  return broken;
}
