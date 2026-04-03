import { Controller, Post, Get, Body, UseGuards, Request } from '@nestjs/common';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { SignupDto, LoginDto, VerifyOtpDto, GoogleAuthDto, GoogleExchangeDto, ResendOtpDto } from './dto/auth.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // 5 signup attempts per minute per IP
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post('signup')
  signup(@Body() dto: SignupDto) {
    return this.authService.signup(dto);
  }

  // 10 login attempts per minute per IP
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  // 5 OTP verifications per minute per IP (brute-force protection)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post('verify-otp')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  // 3 resend requests per minute per IP
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @Post('resend-otp')
  resendOtp(@Body() dto: ResendOtpDto) {
    return this.authService.resendOtp(dto);
  }

  // 10 Google auth attempts per minute per IP
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('google')
  googleAuth(@Body() dto: GoogleAuthDto) {
    return this.authService.googleAuth(dto);
  }

  // Returns the public Google client ID so the desktop app can build the OAuth URL
  @SkipThrottle()
  @Get('google/config')
  googleConfig() {
    return this.authService.googleConfig();
  }

  // Accepts the OAuth authorization code, exchanges it server-side (secret stays on server)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('google/exchange')
  googleExchange(@Body() dto: GoogleExchangeDto) {
    return this.authService.googleExchange(dto);
  }

  @SkipThrottle()
  @UseGuards(JwtAuthGuard)
  @Get('profile')
  getProfile(@Request() req: any) {
    return this.authService.getProfile(req.user.sub);
  }
}
