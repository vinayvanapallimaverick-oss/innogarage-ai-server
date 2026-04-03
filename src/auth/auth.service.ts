import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from './mail.service';
import { SignupDto, LoginDto, VerifyOtpDto, GoogleAuthDto, GoogleExchangeDto, ResendOtpDto } from './dto/auth.dto';
import { OAuth2Client } from 'google-auth-library';

@Injectable()
export class AuthService {
  private googleClient: OAuth2Client;
  // Dummy hash used in login to keep response time constant regardless of
  // whether the email exists, preventing timing-based email enumeration.
  private static readonly DUMMY_HASH =
    '$2b$12$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private mailService: MailService,
  ) {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    this.googleClient = new OAuth2Client(clientId);
  }

  async signup(dto: SignupDto) {
    if (dto.password !== dto.confirmPassword) {
      throw new BadRequestException('Passwords do not match');
    }

    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (existing) {
      if (!existing.isVerified) {
        // No email configured — auto-verify and return token directly
        if (!this.mailService.isEmailConfigured()) {
          await this.prisma.user.update({
            where: { id: existing.id },
            data: { isVerified: true },
          });
          const token = this.generateToken(existing.id, existing.email);
          return {
            message: 'Account verified automatically (no email configured)',
            accessToken: token,
            user: { id: existing.id, fullName: existing.fullName, email: existing.email, phone: existing.phone },
          };
        }
        await this.generateAndSendOtp(existing.id, existing.email);
        return {
          message: 'Verification code resent. Please check your email.',
          email: existing.email,
          requiresVerification: true,
        };
      }
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);

    const user = await this.prisma.user.create({
      data: {
        fullName: dto.fullName,
        email: dto.email.toLowerCase(),
        phone: dto.phone || null,
        passwordHash,
        isVerified: !this.mailService.isEmailConfigured(),
      },
    });

    // No email configured — return token directly, skip OTP
    if (!this.mailService.isEmailConfigured()) {
      const token = this.generateToken(user.id, user.email);
      return {
        message: 'Account created and verified automatically',
        accessToken: token,
        user: { id: user.id, fullName: user.fullName, email: user.email, phone: user.phone },
      };
    }

    await this.generateAndSendOtp(user.id, user.email);

    return {
      message: 'Signup successful. Please verify your email with the OTP sent.',
      email: user.email,
      requiresVerification: true,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    // Always run bcrypt.compare to prevent timing-based email enumeration
    const hashToCheck = user?.passwordHash ?? AuthService.DUMMY_HASH;
    const valid = await bcrypt.compare(dto.password, hashToCheck);

    if (!user || !user.passwordHash || !valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // No email configured — return token directly, skip OTP
    if (!this.mailService.isEmailConfigured()) {
      if (!user.isVerified) {
        await this.prisma.user.update({ where: { id: user.id }, data: { isVerified: true } });
      }
      const token = this.generateToken(user.id, user.email);
      return {
        message: 'Login successful',
        accessToken: token,
        user: { id: user.id, fullName: user.fullName, email: user.email, phone: user.phone },
      };
    }

    await this.generateAndSendOtp(user.id, user.email);

    return {
      message: 'Credentials verified. Please enter the OTP sent to your email.',
      email: user.email,
      requiresVerification: true,
    };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const otpRecord = await this.prisma.otpCode.findFirst({
      where: {
        userId: user.id,
        code: dto.code,
        used: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otpRecord) {
      throw new UnauthorizedException('Invalid or expired OTP');
    }

    await this.prisma.$transaction([
      this.prisma.otpCode.update({
        where: { id: otpRecord.id },
        data: { used: true },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: { isVerified: true },
      }),
    ]);

    // Opportunistic cleanup: remove expired and used OTP codes for this user
    // to prevent unbounded table growth under multi-user load.
    this.prisma.otpCode
      .deleteMany({
        where: {
          userId: user.id,
          OR: [{ used: true }, { expiresAt: { lt: new Date() } }],
        },
      })
      .catch(() => {}); // fire-and-forget — don't block the auth response

    const token = this.generateToken(user.id, user.email);

    return {
      message: 'Verification successful',
      accessToken: token,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
      },
    };
  }

  googleConfig() {
    return {
      clientId: this.configService.get<string>('GOOGLE_CLIENT_ID') || '',
    };
  }

  async googleExchange(dto: GoogleExchangeDto) {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.configService.get<string>('GOOGLE_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      throw new UnauthorizedException('Google OAuth not configured on server');
    }

    const tokenClient = new OAuth2Client(clientId, clientSecret, dto.redirectUri);
    const { tokens } = await tokenClient.getToken(dto.code);

    if (!tokens.id_token) {
      throw new UnauthorizedException('Failed to retrieve ID token from Google');
    }

    const ticket = await tokenClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: clientId,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      throw new UnauthorizedException('Invalid Google token');
    }

    return this.upsertGoogleUser(payload);
  }

  async googleAuth(dto: GoogleAuthDto) {
    const ticket = await this.googleClient.verifyIdToken({
      idToken: dto.idToken,
      audience: this.configService.get<string>('GOOGLE_CLIENT_ID'),
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      throw new UnauthorizedException('Invalid Google token');
    }

    return this.upsertGoogleUser(payload);
  }

  private async upsertGoogleUser(payload: { email?: string; name?: string; sub?: string; phone?: string }) {
    if (!payload.email) {
      throw new UnauthorizedException('Invalid Google token');
    }
    let user = await this.prisma.user.findUnique({
      where: { email: payload.email.toLowerCase() },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          fullName: payload.name || 'Google User',
          email: payload.email.toLowerCase(),
          googleId: payload.sub,
          isVerified: true,
        },
      });
    } else if (!user.googleId) {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { googleId: payload.sub, isVerified: true },
      });
    }

    const token = this.generateToken(user.id, user.email);

    return {
      message: 'Google authentication successful',
      accessToken: token,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
      },
    };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        isVerified: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return user;
  }

  async resendOtp(dto: ResendOtpDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    // Don't leak whether the email is registered or already verified
    if (!user || user.isVerified) {
      return { message: 'If an unverified account exists for this email, a new code has been sent.' };
    }

    await this.generateAndSendOtp(user.id, user.email);

    return {
      message: 'Verification code resent. Please check your email.',
      email: user.email,
    };
  }

  private async generateAndSendOtp(userId: string, email: string): Promise<void> {
    const code = crypto.randomInt(100000, 999999).toString();

    // Atomically invalidate old codes and create new one
    await this.prisma.$transaction([
      this.prisma.otpCode.updateMany({
        where: { userId, used: false },
        data: { used: true },
      }),
      this.prisma.otpCode.create({
        data: {
          code,
          userId,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
        },
      }),
    ]);

    await this.mailService.sendOtp(email, code);
  }

  private generateToken(userId: string, email: string): string {
    return this.jwtService.sign({ sub: userId, email });
  }
}
