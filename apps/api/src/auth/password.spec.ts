import { hashPassword, verifyPassword } from './password';

describe('password', () => {
  // RULES §7-1
  it('хеш не равен паролю', async () => {
    const hash = await hashPassword('s3cret');
    expect(hash).not.toBe('s3cret');
    expect(hash).not.toContain('s3cret');
  });

  // RULES §7-1
  it('верный пароль проходит, неверный нет', async () => {
    const hash = await hashPassword('s3cret');
    await expect(verifyPassword('s3cret', hash)).resolves.toBe(true);
    await expect(verifyPassword('other', hash)).resolves.toBe(false);
  });

  // RULES §7-1
  it('соль разная: два хеша одного пароля различаются', async () => {
    expect(await hashPassword('s3cret')).not.toBe(await hashPassword('s3cret'));
  });
});
