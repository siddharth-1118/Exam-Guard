import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService, type AuthResult } from './auth.service';
import { MfaService } from './mfa.service';
import { CurrentUser, Public } from '../common/decorators';
import type { UserContext } from '../common/types';
import {
  ForgotPasswordDto,
  LoginDto,
  MfaVerifyDto,
  RefreshDto,
  RegisterDto,
  ResetPasswordDto,
} from './dto';

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
  ) {}

  @Public()
  @Post('register')
  // 10/min per IP by default; test suites raise this via THROTTLE_AUTH_LIMIT.
  @Throttle({ default: { limit: Number(process.env.THROTTLE_AUTH_LIMIT ?? 10), ttl: 60_000 } })
  register(@Body() dto: RegisterDto): Promise<AuthResult> {
    return this.auth.register(dto);
  }

  @Public()
  @Post('login')
  @Throttle({ default: { limit: Number(process.env.THROTTLE_AUTH_LIMIT ?? 10), ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<AuthResult> {
    return this.auth.login(dto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto): Promise<AuthResult> {
    return this.auth.refresh(dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@CurrentUser() user: UserContext): Promise<{ ok: true }> {
    await this.auth.logout(user.userId);
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user: UserContext) {
    return this.auth.me(user.userId);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<{ ok: true }> {
    await this.auth.forgotPassword(dto);
    return { ok: true };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<{ ok: true }> {
    await this.auth.resetPassword(dto);
    return { ok: true };
  }

  // ---- Real TOTP MFA endpoints (C39) ----

  @Post('mfa/enroll')
  @HttpCode(HttpStatus.OK)
  async enrollMfa(@CurrentUser() user: UserContext) {
    return this.mfa.enroll(user.userId);
  }

  @Post('mfa/verify')
  @Throttle({ default: { limit: Number(process.env.THROTTLE_MFA_LIMIT ?? 5), ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async verifyMfa(@CurrentUser() user: UserContext, @Body() dto: MfaVerifyDto): Promise<{ ok: boolean; method: string }> {
    const result = await this.mfa.verify(user.userId, dto.token);
    return { ok: result.verified, method: result.method };
  }

  @Get('mfa/status')
  async mfaStatus(@CurrentUser() user: UserContext) {
    return this.mfa.getStatus(user.userId);
  }

  @Post('mfa/disable')
  @HttpCode(HttpStatus.OK)
  async disableMfa(@CurrentUser() user: UserContext, @Body() dto: MfaVerifyDto): Promise<{ ok: boolean }> {
    await this.mfa.disable(user.userId, dto.token);
    return { ok: true };
  }
}