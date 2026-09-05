import { IsArray, IsBoolean, IsDefined, IsNumber, IsObject, IsOptional, IsString, IsUUID, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

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

export class ManualGradeItemDto {
  @IsUUID()
  questionId!: string;

  @IsNumber()
  @Min(0)
  score!: number;

  @IsOptional()
  @IsString()
  feedback?: string;
}

export class RegradeAttemptDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ManualGradeItemDto)
  grades?: ManualGradeItemDto[];
}