import {
  decisionMail,
  newRequestMail,
  type DecisionMailInput,
  type NewRequestMailInput,
} from './mail-templates';

const base: NewRequestMailInput = {
  employeeName: 'Иванова Мария',
  startDate: '2026-11-02',
  endDate: '2026-11-06',
  workDays: 5,
  backstopperName: 'Петров Пётр',
  comment: null,
  forHr: false,
};

describe('newRequestMail', () => {
  // RULES §8-2: письмо о новой заявке руководителю
  it('обычная заявка: тема и текст', () => {
    expect(newRequestMail(base)).toEqual({
      subject: 'Новая заявка на отпуск: Иванова Мария, 2026-11-02–2026-11-06',
      body: [
        'Иванова Мария подал(а) заявку на отпуск с 2026-11-02 по 2026-11-06.',
        'Рабочих дней: 5. Заменяющий: Петров Пётр.',
      ].join('\n'),
    });
  });

  // RULES §3-7, §8-2: комментарий заявки попадает в письмо, если он есть
  it('с комментарием: строка «Комментарий»', () => {
    expect(newRequestMail({ ...base, comment: 'семейные дела' }).body).toBe(
      [
        'Иванова Мария подал(а) заявку на отпуск с 2026-11-02 по 2026-11-06.',
        'Рабочих дней: 5. Заменяющий: Петров Пётр.',
        'Комментарий: семейные дела',
      ].join('\n'),
    );
  });

  // RULES §4-2, §8-2: заявка директора уходит HR как «допуск HR»
  it('заявка директора: тема «Допуск HR» и пояснение в тексте', () => {
    const mail = newRequestMail({
      ...base,
      employeeName: 'Директор Д',
      forHr: true,
    });
    expect(mail.subject).toBe(
      'Допуск HR: новая заявка на отпуск, Директор Д, 2026-11-02–2026-11-06',
    );
    expect(mail.body).toBe(
      [
        'Директор Д подал(а) заявку на отпуск с 2026-11-02 по 2026-11-06.',
        'Рабочих дней: 5. Заменяющий: Петров Пётр.',
        'Заявку директора подтверждает HR.',
      ].join('\n'),
    );
  });

  // RULES §8-2: в письме нет ссылок
  it.each([false, true])('без ссылок (forHr: %p)', (forHr) => {
    const { subject, body } = newRequestMail({ ...base, forHr });
    expect(`${subject}\n${body}`).not.toMatch(/https?:|www\.|<a\s/i);
  });
});

const decision: DecisionMailInput = {
  startDate: '2026-11-02',
  endDate: '2026-11-06',
  workDays: 5,
  decision: 'approved',
  deciderName: 'Сидоров Сергей',
  comment: null,
  forHr: false,
};

describe('decisionMail', () => {
  // RULES §8-2: письмо о решении сотруднику; DECISIONS 2026-10-28 01:59 - тексты
  it('одобрена: тема и текст', () => {
    expect(decisionMail(decision)).toEqual({
      subject: 'Заявка на отпуск одобрена: 2026-11-02–2026-11-06',
      body: [
        'Ваша заявка на отпуск с 2026-11-02 по 2026-11-06 одобрена.',
        'Рабочих дней: 5. Решение принял(а): Сидоров Сергей.',
      ].join('\n'),
    });
  });

  // RULES §8-2, §4-1: отклонение - то же письмо о решении
  it('отклонена: тема и текст', () => {
    expect(decisionMail({ ...decision, decision: 'rejected' })).toEqual({
      subject: 'Заявка на отпуск отклонена: 2026-11-02–2026-11-06',
      body: [
        'Ваша заявка на отпуск с 2026-11-02 по 2026-11-06 отклонена.',
        'Рабочих дней: 5. Решение принял(а): Сидоров Сергей.',
      ].join('\n'),
    });
  });

  // RULES §4-1: комментарий согласующего необязателен; в письме - только если есть
  it.each(['approved', 'rejected'] as const)(
    'с комментарием (%s): строка «Комментарий»',
    (d) => {
      const { body } = decisionMail({
        ...decision,
        decision: d,
        comment: 'хорошего отдыха',
      });
      expect(body.split('\n')).toHaveLength(3);
      expect(body.split('\n')[2]).toBe('Комментарий: хорошего отдыха');
    },
  );

  // RULES §4-2, §8-2: решение по заявке директора - «допуск HR», письмо директору
  it.each([
    ['approved', 'одобрена'],
    ['rejected', 'отклонена'],
  ] as const)(
    'заявка директора (%s): тема «Допуск HR» и пояснение',
    (d, word) => {
      const mail = decisionMail({
        ...decision,
        decision: d,
        deciderName: 'HR Х',
        comment: 'ок',
        forHr: true,
      });
      expect(mail.subject).toBe(
        `Допуск HR: заявка на отпуск ${word}, 2026-11-02–2026-11-06`,
      );
      expect(mail.body).toBe(
        [
          `Ваша заявка на отпуск с 2026-11-02 по 2026-11-06 ${word}.`,
          'Рабочих дней: 5. Решение принял(а): HR Х.',
          'Комментарий: ок',
          'Решение по заявке директора принимает HR (допуск HR).',
        ].join('\n'),
      );
    },
  );

  // RULES §8-2: в письме нет ссылок
  it.each([false, true])('без ссылок (forHr: %p)', (forHr) => {
    const { subject, body } = decisionMail({ ...decision, forHr });
    expect(`${subject}\n${body}`).not.toMatch(/https?:|www\.|<a\s/i);
  });
});
