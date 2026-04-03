import { IsNotEmpty, IsString, IsIn } from 'class-validator';

export class CreateCheckoutDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(['day', 'week', 'month'])
  plan: string;
}
