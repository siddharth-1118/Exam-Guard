import { hashPassword, verifyPassword, safeEqual } from '../src/password';

describe('password hashing (scrypt)', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('S3cure!Pass');
    expect(hash.startsWith('scrypt$')).toBe(true);
    await expect(verifyPassword('S3cure!Pass', hash)).resolves.toBe(true);
  });

  it('rejects wrong password', async () => {
    const hash = await hashPassword('correct');
    await expect(verifyPassword('wrong', hash)).resolves.toBe(false);
  });

  it('uses a unique salt per hash', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
  });

  it('rejects malformed hashes', async () => {
    await expect(verifyPassword('x', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$bad')).resolves.toBe(false);
  });
});

describe('safeEqual', () => {
  it('compares strings in constant time semantics', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
  });
});