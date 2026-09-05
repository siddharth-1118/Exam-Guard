import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type { Difficulty, QuestionType } from '@examguard/types';

const TYPES: QuestionType[] = [
  'SINGLE_CHOICE',
  'MULTIPLE_CHOICE',
  'TRUE_FALSE',
  'SHORT_ANSWER',
  'LONG_ANSWER',
  'NUMERIC',
  'CODE',
];
const DIFFICULTIES: Difficulty[] = ['EASY', 'MEDIUM', 'HARD'];

export class QuestionOptionDto {
  @IsString()
  @Length(1, 500)
  text!: string;

  @IsOptional()
  @IsBoolean()
  isCorrect?: boolean;

  @IsOptional()
  @IsNumber()
  order?: number;
}

export class CreateQuestionDto {
  @IsIn(TYPES)
  type!: QuestionType;

  @IsString()
  @Length(1, 4000)
  text!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  marks?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  negativeMarks?: number;

  @IsOptional()
  @IsIn(DIFFICULTIES)
  difficulty?: Difficulty;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => QuestionOptionDto)
  options?: QuestionOptionDto[];
}

export class UpdateQuestionDto {
  @IsOptional() @IsIn(TYPES) type?: QuestionType;
  @IsOptional() @IsString() @Length(1, 4000) text?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1000) marks?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1000) negativeMarks?: number;
  @IsOptional() @IsIn(DIFFICULTIES) difficulty?: Difficulty;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => QuestionOptionDto) options?: QuestionOptionDto[];
}

export class CreateBankDto {
  @IsString()
  @Length(2, 200)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  description?: string;
}

export class BulkImportQuestionsDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CreateQuestionDto)
  questions!: CreateQuestionDto[];
}