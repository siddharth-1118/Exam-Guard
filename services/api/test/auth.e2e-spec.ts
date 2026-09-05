import { createTestApp, closeTestApp, registerOrg, login, uniqueEmail, DEV_PASSWORD, authed, type TestCtx } from './test-utils';

describe('auth (e2e)', () => {
  let ctx: TestCtx;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('registers an organization and logs in', async () => {
    const reg = await registerOrg(ctx, `Org ${Date.now()}`);
    expect(reg.user.role).toBe('ORG_ADMIN');
    expect(reg.accessToken).toBeTruthy();
    expect(reg.refreshToken).toBeTruthy();

    const loginRes = await ctx.http
      .post(`/api/v1/auth/login`)
      .send({ email: reg.user.email, password: DEV_PASSWORD })
      .expect(200);
    expect(loginRes.body.accessToken).toBeTruthy();
  });

  it('rejects wrong password', async () => {
    const reg = await registerOrg(ctx, `Org ${Date.now()}`);
    await ctx.http
      .post(`/api/v1/auth/login`)
      .send({ email: reg.user.email, password: 'WrongPass123' })
      .expect(401);
  });

  it('rejects duplicate email registration', async () => {
    const email = uniqueEmail('dup');
    await registerOrg(ctx, `Org ${Date.now()}`, email);
    await ctx.http
      .post(`/api/v1/auth/register`)
      .send({ email, password: DEV_PASSWORD, firstName: 'X', lastName: 'Y', organizationName: 'Other' })
      .expect(409);
  });

  it('refreshes tokens and revokes them on logout', async () => {
    const reg = await registerOrg(ctx, `Org ${Date.now()}`);
    const refresh = await ctx.http
      .post(`/api/v1/auth/refresh`)
      .send({ refreshToken: reg.refreshToken })
      .expect(200);
    expect(refresh.body.accessToken).toBeTruthy();

    // Logout revokes all refresh tokens (tokenVersion bump)
    await ctx.http
      .post(`/api/v1/auth/logout`)
      .set(authed(reg.accessToken))
      .expect(200);
    await ctx.http
      .post(`/api/v1/auth/refresh`)
      .send({ refreshToken: reg.refreshToken })
      .expect(401);
  });

  it('rejects expired or garbage access tokens', async () => {
    await ctx.http
      .get(`/api/v1/exams`)
      .set(authed('garbage.token.value'))
      .expect(401);
    await ctx.http.get(`/api/v1/exams`).expect(401);
  });

  it('exposes health endpoints', async () => {
    await ctx.http.get('/health').expect(200);
    await ctx.http.get('/ready').expect(200);
  });

  it('forgot-password always returns ok (no enumeration)', async () => {
    await ctx.http
      .post(`/api/v1/auth/forgot-password`)
      .send({ email: 'nobody@examguard.test' })
      .expect(200);
  });
});