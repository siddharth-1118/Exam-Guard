import { IsEmail, IsString, Length, Matches } from 'class-validator';

export class CreateMonitorDto {
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
}