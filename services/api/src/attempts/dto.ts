import { IsBoolean, IsDefined, IsObject, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class StartAttemptDto {
  @IsUUID()
  examId!: string;

  @IsOptional()
  @IsObject()
  deviceInfo?: {
    os?: string;
    appVersion?: string;
    [key: string]: unknown;
  };

  @IsOptional()
  @IsObject()
  consent?: {
    version?: string;
    camera?: boolean;
    microphone?: boolean;
    screen?: boolean;
    acceptedAt?: string;
  };
}

export class SaveAnswerDto {
  @IsUUID()
  questionId!: string;

  /** Any JSON value — must be present to survive whitelist validation. */
  @IsDefined({ message: 'value is required' })
  value!: unknown;

  @IsOptional()
  @IsBoolean()
  syncedFromOffline?: boolean;
}

export class SubmitDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  confirmation?: string;
}