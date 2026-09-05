import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type { ExamStatus } from '@examguard/types';

const STATUSES: ExamStatus[] = ['DRAFT', 'SCHEDULED', 'OPEN', 'CLOSED'];

export class ExamSettingsDto {
  @IsOptional() @IsBoolean() cameraRequired?: boolean;
  @IsOptional() @IsBoolean() microphoneRequired?: boolean;
  @IsOptional() @IsBoolean() screenMonitoringRequired?: boolean;
  @IsOptional() @IsBoolean() identityVerificationRequired?: boolean;
  @IsOptional() @IsBoolean() aiProctoringEnabled?: boolean;
  @IsOptional() @IsIn(['ALLOW', 'BLOCK', 'NOTIFY']) clipboardPolicy?: string;
  @IsOptional() @IsIn(['REQUIRED', 'RECOMMENDED', 'NOT_REQUIRED']) fullScreenPolicy?: string;
  @IsOptional() @IsIn(['BLOCK', 'DETECT', 'ALLOW']) appSwitchPolicy?: string;
  @IsOptional() @IsIn(['ALERT', 'BLOCK', 'ALLOW']) multipleFacePolicy?: string;
  @IsOptional() @IsBoolean() phoneObjectDetection?: boolean;
  @IsOptional() @IsBoolean() allowOfflineMode?: boolean;
  @IsOptional() @IsIn(['NONE', 'EVENT_ONLY', 'FULL_RECORDING']) evidencePolicy?: string;
  @IsOptional() @IsInt() @Min(1) @Max(3650) retentionDays?: number;
}

export class CreateExamDto {
  @IsString()
  @Length(2, 200)
  name!: string;

  @IsOptional() @IsString() @Length(0, 2000) description?: string;
  @IsOptional() @IsString() @Length(0, 4000) instructions?: string;
  @IsOptional() @IsDateString() startAt?: string;
  @IsOptional() @IsDateString() endAt?: string;

  @IsOptional() @IsInt() @Min(1) @Max(1440) durationMinutes?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10) maxAttempts?: number;
  @IsOptional() @IsBoolean() shuffleQuestions?: boolean;
  @IsOptional() @IsBoolean() shuffleOptions?: boolean;
  @IsOptional() @IsBoolean() negativeMarkingEnabled?: boolean;
  // Negative marking is a fraction of the question's marks (0..1), e.g. 0.25.
  @IsOptional() @IsNumber() @Min(0) @Max(1) negativeMarkingValue?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) passingScore?: number;
  @IsOptional() @IsBoolean() autoSubmit?: boolean;

  @IsOptional() @IsIn(STATUSES) status?: ExamStatus;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ExamSettingsDto)
  settings?: ExamSettingsDto;
}

export class UpdateExamDto {
  @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @IsString() @Length(0, 2000) description?: string;
  @IsOptional() @IsString() @Length(0, 4000) instructions?: string;
  @IsOptional() @IsDateString() startAt?: string;
  @IsOptional() @IsDateString() endAt?: string;
  @IsOptional() @IsInt() @Min(1) @Max(1440) durationMinutes?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10) maxAttempts?: number;
  @IsOptional() @IsBoolean() shuffleQuestions?: boolean;
  @IsOptional() @IsBoolean() shuffleOptions?: boolean;
  @IsOptional() @IsBoolean() negativeMarkingEnabled?: boolean;
  // Negative marking is a fraction of the question's marks (0..1), e.g. 0.25.
  @IsOptional() @IsNumber() @Min(0) @Max(1) negativeMarkingValue?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) passingScore?: number;
  @IsOptional() @IsBoolean() autoSubmit?: boolean;
  @IsOptional() @IsIn(STATUSES) status?: ExamStatus;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => ExamSettingsDto) settings?: ExamSettingsDto;
}

export class LinkQuestionsDto {
  @IsArray()
  @ArrayMinSize(1)
  questionIds!: string[];
}

export class AssignStudentsDto {
  @IsArray()
  @ArrayMinSize(1)
  studentIds!: string[];
}

export class AssignMonitorsDto {
  @IsArray()
  @ArrayMinSize(1)
  monitorIds!: string[];
}