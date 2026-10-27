import type { CalendarDate } from '../domain';

/** Данные письма о новой заявке; ссылок в письме нет (RULES §8-2). */
export interface NewRequestMailInput {
  employeeName: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
  workDays: number;
  backstopperName: string;
  comment: string | null;
  /** Заявка директора: письмо получает HR, «допуск HR» (RULES §4-2). */
  forHr: boolean;
}

export interface MailContent {
  subject: string;
  body: string;
}

/** Тема и текст письма NEW_REQUEST (тексты определены в S4, architecture §10). */
export function newRequestMail(m: NewRequestMailInput): MailContent {
  const period = `${m.startDate}–${m.endDate}`;
  const subject = m.forHr
    ? `Допуск HR: новая заявка на отпуск, ${m.employeeName}, ${period}`
    : `Новая заявка на отпуск: ${m.employeeName}, ${period}`;
  const lines = [
    `${m.employeeName} подал(а) заявку на отпуск с ${m.startDate} по ${m.endDate}.`,
    `Рабочих дней: ${m.workDays}. Заменяющий: ${m.backstopperName}.`,
  ];
  if (m.comment) lines.push(`Комментарий: ${m.comment}`);
  if (m.forHr) lines.push('Заявку директора подтверждает HR.');
  return { subject, body: lines.join('\n') };
}

/** Данные письма о решении автору заявки; ссылок в письме нет (RULES §8-2). */
export interface DecisionMailInput {
  startDate: CalendarDate;
  endDate: CalendarDate;
  workDays: number;
  decision: 'approved' | 'rejected';
  /** Кто принял решение: руководитель, для заявки директора - HR (RULES §4-1, §4-2). */
  deciderName: string;
  /** Комментарий согласующего, необязателен (RULES §4-1). */
  comment: string | null;
  /** Заявка директора: решение принимает HR, «допуск HR» (RULES §4-2). */
  forHr: boolean;
}

/** Тема и текст письма DECISION (тексты определены в S5, architecture §10). */
export function decisionMail(m: DecisionMailInput): MailContent {
  const word = m.decision === 'approved' ? 'одобрена' : 'отклонена';
  const period = `${m.startDate}–${m.endDate}`;
  const subject = m.forHr
    ? `Допуск HR: заявка на отпуск ${word}, ${period}`
    : `Заявка на отпуск ${word}: ${period}`;
  const lines = [
    `Ваша заявка на отпуск с ${m.startDate} по ${m.endDate} ${word}.`,
    `Рабочих дней: ${m.workDays}. Решение принял(а): ${m.deciderName}.`,
  ];
  if (m.comment) lines.push(`Комментарий: ${m.comment}`);
  if (m.forHr)
    lines.push('Решение по заявке директора принимает HR (допуск HR).');
  return { subject, body: lines.join('\n') };
}
