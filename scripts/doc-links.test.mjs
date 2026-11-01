import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anchors, brokenLinks, links } from './doc-links.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('README и документы для проверяющего: все относительные ссылки и якоря существуют', () => {
  assert.deepEqual(brokenLinks(root), []);
});

test('якорь как у GitHub: без знаков препинания, пробел → «-», повтор получает номер', () => {
  const a = anchors('# Демо-сценарий согласования (seed:demo)\n## Тесты и CI\n## Тесты и CI\n```\n# не заголовок\n```');
  assert.deepEqual([...a], ['демо-сценарий-согласования-seeddemo', 'тесты-и-ci', 'тесты-и-ci-1']);
});

test('внешние ссылки и ссылки в коде не проверяются', () => {
  const found = links('[a](https://x.y) [b](docs/A.md#h) `[c](nope.md)`\n```\n[d](nope.md)\n```');
  assert.deepEqual(found, [{ target: 'docs/A.md#h', line: 1 }]);
});

test('битая ссылка и битый якорь находятся', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-'));
  fs.writeFileSync(path.join(dir, 'A.md'), '# Есть\n[x](B.md) [y](#нет) [z](#есть)\n');
  assert.deepEqual(brokenLinks(dir, ['A.md']), ['A.md:2: нет файла B.md', 'A.md:2: нет заголовка #нет']);
});
