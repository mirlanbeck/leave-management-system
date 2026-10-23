import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractRefs, parseRules, trace } from './trace-rules.mjs';

const RULES = `# R
## 1. Один
- a
- b
  - вложенный
## 2. Два
- c
| таблица |
- d
- e
`;

function fixture(specSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
  const rulesPath = path.join(dir, 'RULES.md');
  fs.writeFileSync(rulesPath, RULES);
  fs.writeFileSync(path.join(dir, 'x.spec.ts'), specSource);
  return { rulesPath, rootDir: dir };
}

test('parseRules считает только пункты верхнего уровня', () => {
  assert.deepEqual([...parseRules(RULES)], [[1, 2], [2, 3]]);
});

test('extractRefs читает несколько ссылок в одном комментарии', () => {
  const refs = extractRefs('// RULES §1, §2-3\nconst x = "§9";');
  assert.deepEqual(refs.map((r) => [r.section, r.item]), [[1, null], [2, 3]]);
});

test('существующие §N и §N-k проходят', () => {
  const { table, errors } = trace(fixture('// RULES §1\n// RULES §2-3\n'));
  assert.equal(errors.length, 0);
  assert.deepEqual([...table.keys()].sort(), ['§1', '§2-3']);
});

test('несуществующий §N падает', () => {
  const { errors } = trace(fixture('// RULES §7\n'));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /нет раздела §7/);
});

test('несуществующий §N-k падает', () => {
  const { errors } = trace(fixture('// RULES §1-3\n// RULES §2-4\n'));
  assert.equal(errors.length, 2);
  assert.match(errors[0], /нет пункта §1-3/);
});
