import { IsOptional, IsString, Length } from 'class-validator';

export class RequestDeletionDto {
  @IsOptional()
  @IsString()
  @Length(1, 500)
  reason?: string;
}
