import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJestArgs } from './test-int-args.mjs';

const BASE = [
  '--runInBand',
  '--testTimeout=30000',
  '--testRegex',
  '\\.int\\.spec\\.ts$',
];

test('без аргументов прежняя команда: все integration-тесты', () => {
  assert.deepEqual(buildJestArgs([]), BASE);
});

test('путь передаётся как --testPathPatterns, а не в testRegex', () => {
  assert.deepEqual(buildJestArgs(['access-matrix']), [
    ...BASE,
    '--testPathPatterns',
    'access-matrix',
  ]);
});

test('несколько путей идут одним --testPathPatterns', () => {
  assert.deepEqual(buildJestArgs(['approvals', 'vacations']), [
    ...BASE,
    '--testPathPatterns',
    'approvals',
    'vacations',
  ]);
});

test('только флаги jest передаются без изменений', () => {
  assert.deepEqual(buildJestArgs(['-t', 'decide', '--verbose']), [
    ...BASE,
    '-t',
    'decide',
    '--verbose',
  ]);
});

test('пути до первого флага, флаги после них без изменений', () => {
  assert.deepEqual(buildJestArgs(['approvals', '-t', 'decide']), [
    ...BASE,
    '--testPathPatterns',
    'approvals',
    '-t',
    'decide',
  ]);
});

test('значение флага из нескольких слов остаётся одним аргументом', () => {
  const args = buildJestArgs(['approvals', '-t', 'два слова']);
  assert.equal(args.at(-1), 'два слова');
});

test('аргумент после флага не считается путём и передаётся как есть', () => {
  assert.deepEqual(buildJestArgs(['--verbose', 'approvals']), [
    ...BASE,
    '--verbose',
    'approvals',
  ]);
});
