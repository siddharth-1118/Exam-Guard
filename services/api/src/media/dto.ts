import { IsOptional, IsUUID } from 'class-validator';

export class CreateMediaSessionDto {
  @IsUUID()
  attemptId!: string;
}

export class ListExamSessionsQuery {
  @IsUUID()
  examId!: string;
}

/**
 * Monitor subscriber authorization (Phase 4C). Only `attemptId` is required —
 * the participant is derived server-side from the attempt's media row so a
 * monitor cannot select an arbitrary participant. When a participantId IS
 * supplied it must match the attempt's row (otherwise the request is treated
 * as not-found).
 */
export class SubscriberTokenDto {
  @IsUUID()
  attemptId!: string;

  @IsOptional()
  @IsUUID()
  participantId?: string;
}
