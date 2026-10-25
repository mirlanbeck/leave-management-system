import { truncateAll } from './test-db';

// Защита рабочей БД: тесты не должны стирать данные запущенного стека.
describe('truncateAll', () => {
  const dbWith = (name: string) => {
    const query = jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('current_database()')
          ? { rows: [{ name }] }
          : { rows: [] },
      ),
    );
    return { query } as unknown as Parameters<typeof truncateAll>[0];
  };

  it('отказывается чистить БД без суффикса _test', async () => {
    await expect(truncateAll(dbWith('leave'))).rejects.toThrow(/_test/);
  });

  it('чистит БД с суффиксом _test', async () => {
    await expect(truncateAll(dbWith('leave_test'))).resolves.toBeUndefined();
  });
});
