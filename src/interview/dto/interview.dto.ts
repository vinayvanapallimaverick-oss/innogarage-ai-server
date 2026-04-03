import { IsString, IsNotEmpty, IsOptional, IsArray, ValidateNested, MaxLength, ArrayMaxSize, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

class ProfileContextDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  prompt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  companyName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  role?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  experience?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  interviewType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  resumeText?: string;
}

class HistoryItemDto {
  @IsString()
  @MaxLength(2000)
  question: string;

  @IsString()
  @MaxLength(5000)
  answer: string;
}

export class ScreenAnalyzeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000000)
  image: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ProfileContextDto)
  profile?: ProfileContextDto;
}

class MemoryShortTermItemDto {
  @IsString()
  @MaxLength(2000)
  question: string;

  @IsString()
  @MaxLength(5000)
  answer: string;
}

class ConversationMemoryDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => MemoryShortTermItemDto)
  shortTerm?: MemoryShortTermItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  summary?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  topics?: string[];
}

export class AnalyzeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  transcript: string;

  @IsOptional()
  @IsString()
  @IsIn(['question', 'prompt', 'followup', 'filler', 'noise'])
  intent?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ProfileContextDto)
  profile?: ProfileContextDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ConversationMemoryDto)
  memory?: ConversationMemoryDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => HistoryItemDto)
  history?: HistoryItemDto[];
}


