// Аргументы jest для test:int. Аргументы до первого флага считаются путями и идут в --testPathPatterns:
// --testRegex принимает несколько значений, и путь сразу после него стал бы ещё одной регуляркой
// (тогда запускаются все integration-тесты). Флаги и всё после первого из них передаются как есть.
export function buildJestArgs(argv) {
  const firstFlag = argv.findIndex((a) => a.startsWith('-'));
  const split = firstFlag === -1 ? argv.length : firstFlag;
  const paths = argv.slice(0, split);
  return [
    '--runInBand',
    '--testTimeout=30000',
    '--testRegex',
    '\\.int\\.spec\\.ts$',
    ...(paths.length ? ['--testPathPatterns', ...paths] : []),
    ...argv.slice(split),
  ];
}
