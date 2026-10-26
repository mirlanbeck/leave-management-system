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
