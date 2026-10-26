import { newRequestMail, type NewRequestMailInput } from './mail-templates';

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
