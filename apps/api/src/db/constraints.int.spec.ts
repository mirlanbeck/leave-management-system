// Integration-тесты ограничений БД (S1). Нужен Postgres с применёнными миграциями: DATABASE_URL.
import { Pool } from 'pg';
import {
  Org,
  createPool,
  findChainRoot,
  insertLedger,
  insertMail,
  insertUser,
  insertVacation,
  pgFailure,
  seedOrg,
  truncateAll,
} from './test-db';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const EXCLUSION_VIOLATION = '23P01';

describe('ограничения БД (integration)', () => {
  let pool: Pool;
  let org: Org;

  beforeAll(() => {
    pool = createPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    org = await seedOrg(pool);
  });

  const vac = (o: Partial<Parameters<typeof insertVacation>[1]> = {}) =>
    insertVacation(pool, {
      employeeId: org.employee,
      backstopperId: org.other,
      start: '2026-10-19',
      end: '2026-10-23',
      ...o,
    });

  describe('Vacation: форма заявки', () => {
    it('начало позже конца не проходит', async () => {
      // RULES §3-4: правила формы заявки
      const f = await pgFailure(
        vac({ start: '2026-10-23', end: '2026-10-19' }),
      );
      expect(f.code).toBe(CHECK_VIOLATION);
      expect(f.constraint).toBe('Vacation_dates_order_chk');
    });

    it('заявка через Новый год не проходит', async () => {
      // RULES §3-4: одна заявка — в пределах одного календарного года
      const f = await pgFailure(
        vac({ start: '2026-12-30', end: '2027-01-04' }),
      );
      expect(f.code).toBe(CHECK_VIOLATION);
      expect(f.constraint).toBe('Vacation_one_year_chk');
    });

    it('заявки 31 декабря и 1 января по отдельности проходят', async () => {
      // RULES §3-4: две заявки вместо одной через Новый год
      await vac({ start: '2026-12-28', end: '2026-12-31', workDays: 4 });
      await vac({ start: '2027-01-01', end: '2027-01-05', workDays: 3 });
    });

    it('заявка без рабочих дней (workDays = 0) не проходит', async () => {
      // RULES §3-4: минимум 1 рабочий день
      const f = await pgFailure(
        vac({ start: '2026-10-24', end: '2026-10-25', workDays: 0 }),
      );
      expect(f.code).toBe(CHECK_VIOLATION);
      expect(f.constraint).toBe('Vacation_work_days_chk');
    });

    it('сам себе backstopper не проходит', async () => {
      // RULES §3-3: backstopper — любой сотрудник, кроме заявителя
      const f = await pgFailure(vac({ backstopperId: org.employee }));
      expect(f.code).toBe(CHECK_VIOLATION);
      expect(f.constraint).toBe('Vacation_backstopper_not_self_chk');
    });
  });

  describe('Vacation: пересечения', () => {
    it('пересекающиеся одобренные отпуска одного сотрудника не проходят', async () => {
      // RULES §3-4: нет пересечения с другой активной заявкой или отпуском
      await vac({ status: 'APPROVED' });
      const f = await pgFailure(
        vac({ start: '2026-10-23', end: '2026-10-30', status: 'APPROVED' }),
      );
      expect(f.code).toBe(EXCLUSION_VIOLATION);
      expect(f.constraint).toBe('Vacation_no_approved_overlap_excl');
    });

    it('соседние даты (конец 23-го, начало 26-го) и другой сотрудник проходят', async () => {
      // RULES §3-4
      await vac({ status: 'APPROVED' });
      await vac({ start: '2026-10-26', end: '2026-10-30', status: 'APPROVED' });
      await vac({
        employeeId: org.other,
        backstopperId: org.employee,
        status: 'APPROVED',
      });
    });

    it('ожидающая заявка пересекается с одобренной (так устроен перенос)', async () => {
      // RULES §5-2: перенос пересекается со старым отпуском, пока ждёт решения
      const a = await vac({ status: 'APPROVED' });
      await vac({ start: '2026-10-22', end: '2026-10-28', replacesId: a });
    });

    it('отменённый, отклонённый и замещённый отпуск не блокируют даты', async () => {
      // RULES §3-11: пересечения считаются по активным статусам
      await vac({ status: 'CANCELLED' });
      await vac({ status: 'REJECTED' });
      await vac({ status: 'REPLACED' });
      await vac({ status: 'APPROVED' });
    });
  });

  describe('Vacation: перенос', () => {
    it('второй ожидающий перенос того же отпуска не проходит', async () => {
      // RULES §5-2: пока перенос ждёт решения, подать второй нельзя
      const a = await vac({ status: 'APPROVED' });
      await vac({ start: '2026-10-26', end: '2026-10-30', replacesId: a });
      const f = await pgFailure(
        vac({ start: '2026-11-02', end: '2026-11-06', replacesId: a }),
      );
      expect(f.code).toBe(UNIQUE_VIOLATION);
      expect(f.constraint).toBe('Vacation_single_live_successor_idx');
    });

    it('после отклонения переноса можно подать новый', async () => {
      // RULES §3-11: отклонённый перенос оставляет старый отпуск «Одобрена»
      const a = await vac({ status: 'APPROVED' });
      await vac({
        start: '2026-10-26',
        end: '2026-10-30',
        replacesId: a,
        status: 'REJECTED',
      });
      await vac({ start: '2026-11-02', end: '2026-11-06', replacesId: a });
    });

    it('утверждение переноса: сначала старый -> REPLACED, затем новый -> APPROVED', async () => {
      // RULES §5-2: порядок обновлений в одной транзакции
      const a = await vac({ status: 'APPROVED' });
      const b = await vac({
        start: '2026-10-22',
        end: '2026-10-28',
        replacesId: a,
      });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE "Vacation" SET status = 'REPLACED' WHERE id = $1`,
          [a],
        );
        await client.query(
          `UPDATE "Vacation" SET status = 'APPROVED' WHERE id = $1`,
          [b],
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      const { rows } = await pool.query(
        `SELECT id, status FROM "Vacation" ORDER BY id`,
      );
      expect(rows).toEqual([
        { id: a, status: 'REPLACED' },
        { id: b, status: 'APPROVED' },
      ]);
    });

    it('обратный порядок утверждения переноса не проходит', async () => {
      // RULES §5-2: новый -> APPROVED при ещё одобренном старом нарушает исключение
      const a = await vac({ status: 'APPROVED' });
      const b = await vac({
        start: '2026-10-22',
        end: '2026-10-28',
        replacesId: a,
      });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const f = await pgFailure(
          client.query(
            `UPDATE "Vacation" SET status = 'APPROVED' WHERE id = $1`,
            [b],
          ),
        );
        expect(f.code).toBe(EXCLUSION_VIOLATION);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('цепочка A->B->C сохраняется и читается, корень находится', async () => {
      // RULES §5-12: заявка-перенос хранит ссылку на исходную
      const a = await vac({ status: 'REPLACED' });
      const b = await vac({
        start: '2026-10-26',
        end: '2026-10-30',
        replacesId: a,
        status: 'REPLACED',
      });
      const c = await vac({
        start: '2026-11-02',
        end: '2026-11-06',
        replacesId: b,
        status: 'APPROVED',
      });
      expect(await findChainRoot(pool, c)).toBe(a);
      expect(await findChainRoot(pool, b)).toBe(a);
      expect(await findChainRoot(pool, a)).toBe(a);
    });
  });

  describe('LedgerEntry: журнал', () => {
    it('второе списание по той же заявке не проходит', async () => {
      // RULES §10-1: ровно одно списание
      const v = await vac({ status: 'APPROVED' });
      await insertLedger(pool, { kind: 'DEBIT', vacationId: v, halfDays: 10 });
      const f = await pgFailure(
        insertLedger(pool, { kind: 'DEBIT', vacationId: v, halfDays: 10 }),
      );
      expect(f.code).toBe(UNIQUE_VIOLATION);
      expect(f.constraint).toBe('LedgerEntry_one_debit_per_vacation_idx');
    });

    it('списание с нулём дней не проходит', async () => {
      // RULES §6-6: списание > 0 и без ссылки
      const v = await vac({ status: 'APPROVED' });
      const zero = await pgFailure(
        insertLedger(pool, { kind: 'DEBIT', vacationId: v, halfDays: 0 }),
      );
      expect(zero.constraint).toBe('LedgerEntry_kind_shape_chk');
    });

    it('возврат без ссылки на списание не создаётся', async () => {
      // RULES §6-8: возврат всегда привязан к списанию
      const v = await vac({ status: 'APPROVED' });
      const debit = await insertLedger(pool, {
        kind: 'DEBIT',
        vacationId: v,
        halfDays: 10,
      });
      const f = await pgFailure(
        insertLedger(pool, { kind: 'REFUND', vacationId: v, halfDays: 10 }),
      );
      expect(f.code).toBe(CHECK_VIOLATION);
      expect(f.message).toMatch(/debit entry/);
      // и обратно: списание со ссылкой на списание не создаётся
      const d = await pgFailure(
        insertLedger(pool, {
          kind: 'DEBIT',
          vacationId: v,
          refundOfId: debit,
          halfDays: 10,
        }),
      );
      expect(d.constraint).toBe('LedgerEntry_kind_shape_chk');
    });

    it('возврат сверх списанного отклоняется', async () => {
      // RULES §6-8: сумма возвратов не превышает списанного
      const v = await vac({ status: 'APPROVED' });
      const debit = await insertLedger(pool, {
        kind: 'DEBIT',
        vacationId: v,
        halfDays: 10,
      });
      const f = await pgFailure(
        insertLedger(pool, {
          kind: 'REFUND',
          vacationId: v,
          refundOfId: debit,
          halfDays: 12,
        }),
      );
      expect(f.code).toBe(CHECK_VIOLATION);
      expect(f.message).toMatch(/exceed/);
    });

    it('полный и частичный (с даты выхода) возврат проходят, нулевой тоже', async () => {
      // RULES §5-6: возвращаются рабочие дни с даты выхода; 0 допустим (выход в выходной)
      const v = await vac({ status: 'APPROVED' });
      const debit = await insertLedger(pool, {
        kind: 'DEBIT',
        vacationId: v,
        halfDays: 10,
      });
      await insertLedger(pool, {
        kind: 'REFUND',
        vacationId: v,
        refundOfId: debit,
        halfDays: 8,
      });
      const v2 = await vac({
        start: '2026-11-02',
        end: '2026-11-06',
        status: 'APPROVED',
      });
      const debit2 = await insertLedger(pool, {
        kind: 'DEBIT',
        vacationId: v2,
        halfDays: 10,
      });
      await insertLedger(pool, {
        kind: 'REFUND',
        vacationId: v2,
        refundOfId: debit2,
        halfDays: 0,
      });
    });

    it('повторный возврат по той же заявке не создаётся', async () => {
      // RULES §6-8: повторная отмена второго возврата не создаёт («уже обработана», §10-1)
      const v = await vac({ status: 'APPROVED' });
      const debit = await insertLedger(pool, {
        kind: 'DEBIT',
        vacationId: v,
        halfDays: 10,
      });
      await insertLedger(pool, {
        kind: 'REFUND',
        vacationId: v,
        refundOfId: debit,
        halfDays: 4,
      });
      const f = await pgFailure(
        insertLedger(pool, {
          kind: 'REFUND',
          vacationId: v,
          refundOfId: debit,
          halfDays: 4,
        }),
      );
      expect(f.code).toBe(UNIQUE_VIOLATION);
      expect(f.constraint).toBe('LedgerEntry_one_refund_per_vacation_idx');
    });

    it('возврат по цепочке A->B->C ссылается на списание корня A', async () => {
      // RULES §5-12, §6-8: возврат привязывается к списанию корня, даже если отменяют C
      const a = await vac({ status: 'REPLACED' });
      const debitA = await insertLedger(pool, {
        kind: 'DEBIT',
        vacationId: a,
        halfDays: 10,
      });
      const b = await vac({
        start: '2026-10-26',
        end: '2026-10-30',
        replacesId: a,
        status: 'REPLACED',
      });
      const c = await vac({
        start: '2026-11-02',
        end: '2026-11-06',
        replacesId: b,
        status: 'CANCELLED',
      });
      await insertLedger(pool, {
        kind: 'REFUND',
        vacationId: c,
        refundOfId: debitA,
        halfDays: 10,
      });
    });

    it('возврат к списанию промежуточного звена или чужой цепочки отклоняется', async () => {
      // RULES §5-12, §6-8: ссылка только на списание корня цепочки своей заявки
      const a = await vac({ status: 'REPLACED' });
      await insertLedger(pool, { kind: 'DEBIT', vacationId: a, halfDays: 10 });
      const b = await vac({
        start: '2026-10-26',
        end: '2026-10-30',
        replacesId: a,
        status: 'CANCELLED',
      });
      const bDebit = await insertLedger(pool, {
        kind: 'DEBIT',
        vacationId: b,
        halfDays: 10,
      });

      const own = await pgFailure(
        insertLedger(pool, {
          kind: 'REFUND',
          vacationId: b,
          refundOfId: bDebit,
          halfDays: 10,
        }),
      );
      expect(own.code).toBe(CHECK_VIOLATION);
      expect(own.message).toMatch(/chain root/);

      const foreign = await vac({
        employeeId: org.other,
        backstopperId: org.employee,
        status: 'CANCELLED',
      });
      const foreignDebit = await insertLedger(pool, {
        kind: 'DEBIT',
        vacationId: foreign,
        halfDays: 10,
      });
      const cross = await pgFailure(
        insertLedger(pool, {
          kind: 'REFUND',
          vacationId: b,
          refundOfId: foreignDebit,
          halfDays: 2,
        }),
      );
      expect(cross.code).toBe(CHECK_VIOLATION);
    });

    it('два параллельных возврата по одному списанию: проходит один', async () => {
      // RULES §10-1: параллельные запросы, проходит один; сумма возвратов <= списанного
      const a = await vac({ status: 'REPLACED' });
      const debitA = await insertLedger(pool, {
        kind: 'DEBIT',
        vacationId: a,
        halfDays: 10,
      });
      const b = await vac({
        start: '2026-10-26',
        end: '2026-10-30',
        replacesId: a,
        status: 'CANCELLED',
      });

      const first = await pool.connect();
      const second = await pool.connect();
      try {
        await first.query('BEGIN');
        await insertLedger(first, {
          kind: 'REFUND',
          vacationId: a,
          refundOfId: debitA,
          halfDays: 6,
        });
        // второй упирается в FOR UPDATE на списании, пока первый не завершится
        let secondDone = false;
        const secondInsert = pgFailure(
          insertLedger(second, {
            kind: 'REFUND',
            vacationId: b,
            refundOfId: debitA,
            halfDays: 6,
          }),
        ).finally(() => {
          secondDone = true;
        });
        await new Promise((r) => setTimeout(r, 300));
        expect(secondDone).toBe(false);
        await first.query('COMMIT');
        const f = await secondInsert;
        expect(f.code).toBe(CHECK_VIOLATION);
        expect(f.message).toMatch(/exceed/);
      } finally {
        first.release();
        second.release();
      }
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "LedgerEntry" WHERE kind = 'REFUND'`,
      );
      expect(rows[0].n).toBe(1);
    });
  });

  describe('OutboxMessage', () => {
    it('дубль письма «тип + отпуск + получатель» не проходит', async () => {
      // RULES §8-3: уникальность одно письмо на сочетание «тип + id отпуска + получатель»
      const v = await vac({ status: 'APPROVED' });
      await insertMail(pool, {
        type: 'REMINDER',
        vacationId: v,
        recipientId: org.employee,
      });
      const f = await pgFailure(
        insertMail(pool, {
          type: 'REMINDER',
          vacationId: v,
          recipientId: org.employee,
        }),
      );
      expect(f.code).toBe(UNIQUE_VIOLATION);
      expect(f.constraint).toBe(
        'OutboxMessage_type_vacationId_recipientId_key',
      );
    });

    it('другой тип или другой получатель проходят', async () => {
      // RULES §8-3
      const v = await vac({ status: 'APPROVED' });
      await insertMail(pool, {
        type: 'REMINDER',
        vacationId: v,
        recipientId: org.employee,
      });
      await insertMail(pool, {
        type: 'REMINDER',
        vacationId: v,
        recipientId: org.manager,
      });
      await insertMail(pool, {
        type: 'DECISION',
        vacationId: v,
        recipientId: org.employee,
      });
    });
  });

  describe('User и ClockState', () => {
    it('второй пользователь без начальника не проходит', async () => {
      // RULES §7-1: один пользователь без начальника (директор)
      const f = await pgFailure(
        insertUser(pool, { managerId: null, login: 'second-root' }),
      );
      expect(f.code).toBe(UNIQUE_VIOLATION);
      expect(f.constraint).toBe('User_single_root_idx');
    });

    it('пользователь не может быть собственным начальником', async () => {
      // RULES §7-1
      const f = await pgFailure(
        pool.query(`UPDATE "User" SET "managerId" = id WHERE id = $1`, [
          org.employee,
        ]),
      );
      expect(f.constraint).toBe('User_not_own_manager_chk');
    });

    it('состояние демо-часов — одна строка', async () => {
      // RULES §9-2: состояние хранится в БД, одна строка
      await pool.query(
        `INSERT INTO "ClockState" (id, instant) VALUES (1, '2026-10-21T03:00:00Z')`,
      );
      const dup = await pgFailure(
        pool.query(
          `INSERT INTO "ClockState" (id, instant) VALUES (1, '2026-10-22T03:00:00Z')`,
        ),
      );
      expect(dup.code).toBe(UNIQUE_VIOLATION);
      const second = await pgFailure(
        pool.query(
          `INSERT INTO "ClockState" (id, instant) VALUES (2, '2026-10-22T03:00:00Z')`,
        ),
      );
      expect(second.code).toBe(CHECK_VIOLATION);
      expect(second.constraint).toBe('ClockState_single_row_chk');
    });
  });
});
