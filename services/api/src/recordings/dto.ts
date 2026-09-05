import { IsEnum, IsInt, IsOptional, IsUUID, Matches, Min } from 'class-validator';
import { RecordingKind } from '@examguard/database';

/** POST /api/v1/recordings — open a recording session for an attempt. */
export class CreateRecordingDto {
  @IsUUID()
  attemptId!: string;

  @IsEnum(RecordingKind)
  kind!: RecordingKind;

  /** Optional media participant (publisher session) reference — validated against the attempt server-side. */
  @IsOptional()
  @IsUUID()
  participantId?: string;
}

/** POST /api/v1/recordings/:id/finalize — egress reports real object metadata. */
export class FinalizeRecordingDto {
  @IsInt()
  @Min(0)
  sizeBytes!: number;

  @IsInt()
  @Min(0)
  durationMs!: number;

  @Matches(/^[0-9a-f]{64}$/i)
  checksumSha256!: string;
}

/** GET /api/v1/recordings?examId=&attemptId= */
export class ListRecordingsQuery {
  @IsOptional()
  @IsUUID()
  examId?: string;

  @IsOptional()
  @IsUUID()
  attemptId?: string;
}