import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveDispatcher, createReloadOnce } from './live-logic';

// Хук useLiveRefresh - тонкая обёртка над подпиской диспетчера (vitest без DOM),
// поэтому поведение проверяется на диспетчере.

function setup() {
  const reloadPage = vi.fn();
  const live = createLiveDispatcher(reloadPage);
  const onChange = vi.fn();
  const unsubscribe = live.subscribe(onChange);
  return { live, reloadPage, onChange, unsubscribe };
}

const tick = () => vi.advanceTimersByTimeAsync(0);
const approved = { type: 'vacation.approved', employeeId: 6, vacationId: 1 };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('перечитывание по событиям', () => {
  // RULES §10-2: данные страницы уже загружены, первое подключение их не перечитывает
  it('первое подключение без onChange', async () => {
    const { live, onChange } = setup();
    live.onOpen();
    await tick();
    expect(onChange).not.toHaveBeenCalled();
  });

  // RULES §10-2: события при обрыве теряются, после повторного подключения данные перечитываются
  it('повторное подключение после обрыва вызывает onChange', async () => {
    const { live, onChange } = setup();
    live.onOpen();
    live.onDrop();
    live.onOpen();
    await tick();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // RULES §10-2: первая попытка не удалась - событие могло потеряться до первого соединения
  it('первое успешное подключение после неудачной попытки вызывает onChange', async () => {
    const { live, onChange } = setup();
    live.onDrop();
    live.onOpen();
    await tick();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // RULES §10-2: одобрение, отмена или отзыв, утверждение переноса, смена даты выхода
  it.each([
    ['vacation.approved', approved],
    ['vacation.cancelled', { employeeId: 6, vacationId: 1, by: 'HR_RECALL' }],
    ['vacation.transfer-approved', { employeeId: 6, vacationId: 2, replacedId: 1 }],
    ['employee.hire-date-changed', { employeeId: 6 }],
  ])('%s вызывает onChange', async (type, data) => {
    const { live, onChange, reloadPage } = setup();
    live.onOpen();
    live.onEvent(type, data);
    await tick();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(reloadPage).not.toHaveBeenCalled();
  });

  // RULES §10-2
  it('пачка событий в одном чанке - одно перечитывание', async () => {
    const { live, onChange } = setup();
    live.onOpen();
    live.onEvent('vacation.approved', approved);
    live.onEvent('vacation.cancelled', { employeeId: 6, vacationId: 1, by: 'EMPLOYEE' });
    live.onEvent('employee.hire-date-changed', { employeeId: 6 });
    expect(onChange).not.toHaveBeenCalled();
    await tick();
    expect(onChange).toHaveBeenCalledTimes(1);

    live.onEvent('vacation.approved', approved);
    await tick();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  // RULES §10-2: в потоке только события §10-2; незнакомое не перечитывает
  it('незнакомое событие ничего не делает; после отписки onChange не вызывается', async () => {
    const { live, onChange, unsubscribe, reloadPage } = setup();
    live.onEvent('something.else', {});
    await tick();
    expect(onChange).not.toHaveBeenCalled();

    unsubscribe();
    live.onEvent('vacation.approved', approved);
    await tick();
    expect(onChange).not.toHaveBeenCalled();
    expect(reloadPage).not.toHaveBeenCalled();
  });
});

describe('смена демо-часов', () => {
  // RULES §10-2, §9-3 (DECISIONS 2026-10-29 21:18): полная перезагрузка вкладки, один раз
  it('clock.changed - одна перезагрузка страницы, без onChange', async () => {
    const { live, reloadPage, onChange } = setup();
    live.onOpen();
    live.onEvent('clock.changed', { type: 'clock.changed' });
    live.onEvent('clock.changed', { type: 'clock.changed' });
    await tick();
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  // RULES §9-3: вкладка, где установили часы, перезагружается один раз (форма и событие)
  it('reloadOnce общий для формы часов и события', () => {
    const reload = vi.fn();
    const reloadOnce = createReloadOnce(reload);
    const live = createLiveDispatcher(reloadOnce);
    live.onEvent('clock.changed', {});
    reloadOnce(); // форма получила ответ PUT /clock
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
