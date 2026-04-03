import { IsNotEmpty, IsString, IsOptional, MaxLength } from 'class-validator';

export class UpsertProfileDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  prompt: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  companyName?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  role: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  experience: string;

  @IsString()
  @IsOptional()
  interviewType?: string;
}
