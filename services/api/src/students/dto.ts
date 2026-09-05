import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsOptional, IsString, Length, Matches, ValidateNested } from 'class-validator';

export class CreateStudentDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(8, 128)
  @Matches(/[a-zA-Z]/, { message: 'password must contain a letter' })
  @Matches(/[0-9]/, { message: 'password must contain a number' })
  password!: string;

  @IsString()
  @Length(1, 100)
  firstName!: string;

  @IsString()
  @Length(1, 100)
  lastName!: string;

  @IsString()
  @Length(2, 40)
  studentCode!: string;
}

export class UpdateStudentDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class BulkImportStudentsDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CreateStudentDto)
  students!: CreateStudentDto[];
}