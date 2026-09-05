import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, Length, Matches, MinLength } from 'class-validator';
import type { RoleName } from '@examguard/types';

const ROLES: RoleName[] = ['ORG_ADMIN', 'EXAM_MANAGER', 'MONITOR', 'STUDENT'];

export class CreateUserDto {
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

  @IsIn(ROLES)
  role!: RoleName;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  lastName?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsIn(ROLES)
  role?: RoleName;
}