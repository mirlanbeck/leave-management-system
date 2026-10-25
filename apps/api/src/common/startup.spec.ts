import { jwtSecret } from '../auth/jwt-config';
import { testModule } from '../testing/test-app';

describe('старт без JWT_SECRET (RULES §7-1)', () => {
  // RULES §7-1
  it.each([
    ['не задан', undefined],
    ['пустой', ''],
    ['одни пробелы', '   '],
  ])('%s -> приложение не стартует', async (_name, value) => {
    await expect(testModule({ JWT_SECRET: value }).compile()).rejects.toThrow(
      'JWT_SECRET',
    );
  });

  // RULES §7-1
  it('значения по умолчанию нет', () => {
    expect(() => jwtSecret({})).toThrow('JWT_SECRET');
  });

  // RULES §7-1
  it('заданный секрет принимается', async () => {
    await expect(
      testModule({ JWT_SECRET: 's' }).compile(),
    ).resolves.toBeDefined();
  });
});
