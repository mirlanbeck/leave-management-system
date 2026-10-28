import { hireDateChangeError } from './hr-rules';

describe('hireDateChangeError', () => {
  // RULES §7-2: невидимый сотрудник отвечает как несуществующий (architecture §8)
  it('несуществующий - NOT_FOUND, даже у HR', () => {
    expect(
      hireDateChangeError({ exists: false, visible: true, actorIsHr: true }),
    ).toBe('NOT_FOUND');
  });

  // RULES §7-2: NOT_FOUND раньше FORBIDDEN
  it('невидимый для не-HR - NOT_FOUND', () => {
    expect(
      hireDateChangeError({ exists: true, visible: false, actorIsHr: false }),
    ).toBe('NOT_FOUND');
  });

  // RULES §6-1: меняет только HR
  it('видимый, но зритель не HR - FORBIDDEN', () => {
    expect(
      hireDateChangeError({ exists: true, visible: true, actorIsHr: false }),
    ).toBe('FORBIDDEN');
  });

  // RULES §6-1: HR меняет дату любому, в том числе себе (DECISIONS 2026-10-28 19:19)
  it('HR - без ошибки', () => {
    expect(
      hireDateChangeError({ exists: true, visible: true, actorIsHr: true }),
    ).toBeNull();
  });
});
