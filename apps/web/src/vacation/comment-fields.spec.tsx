import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Vacation } from '../api/types';
import { ApprovalCard } from '../approvals/ApprovalCard';
import { TransferForm } from './TransferForm';
import { EMPTY_FORM, VacationForm } from './VacationForm';

const noop = () => {};

function vacation(over: Partial<Vacation> = {}): Vacation {
  return {
    id: 7,
    employee: { id: 6, fullName: 'James Walker' },
    backstopper: { id: 8, fullName: 'Sophie Bennett' },
    startDate: '2026-11-09',
    endDate: '2026-11-13',
    workDays: 5,
    status: 'APPROVED',
    comment: null,
    replacesId: null,
    transferPending: false,
    oldVacationKept: false,
    actions: ['cancel', 'transfer'],
    ...over,
  };
}

/**
 * Атрибуты maxlength всех textarea в разметке (useEffect при рендере на сервере не выполняется).
 * React пишет имя как maxLength; в HTML регистр имени атрибута не важен.
 */
function textareaMaxLengths(html: string): (string | null)[] {
  return [...html.matchAll(/<textarea\b[^>]*>/g)].map((m) => /\bmaxlength="(\d+)"/i.exec(m[0])?.[1] ?? null);
}

// DECISIONS 2026-10-30 14:24: у полей комментария maxLength 400; 21:41: браузер считает единицы UTF-16, как сервер
describe('поле комментария не длиннее 400 символов', () => {
  // RULES §3-8
  it('форма заявки', () => {
    const html = renderToStaticMarkup(<VacationForm values={EMPTY_FORM} onChange={noop} onSubmitted={noop} />);
    expect(textareaMaxLengths(html)).toEqual(['400']);
  });

  // RULES §5-2
  it('форма переноса', () => {
    const html = renderToStaticMarkup(<TransferForm vacation={vacation()} onTransferred={noop} onClose={noop} />);
    expect(textareaMaxLengths(html)).toEqual(['400']);
  });

  // RULES §4-1
  it('карточка согласования', () => {
    const item = {
      vacation: vacation({ status: 'PENDING', actions: ['approve', 'reject'] }),
      availableOnStart: 10,
      overlaps: [],
      canApprove: true,
      blockReason: null,
    };
    const html = renderToStaticMarkup(<ApprovalCard item={item} onReload={noop} onOutcome={noop} />);
    expect(textareaMaxLengths(html)).toEqual(['400']);
  });
});
