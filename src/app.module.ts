import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProfileModule } from './profile/profile.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { InterviewModule } from './interview/interview.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Global rate limiter: 60 requests per 60 seconds per IP by default
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60000, limit: 60 },
    ]),
    PrismaModule,
    AuthModule,
    ProfileModule,
    SubscriptionModule,
    InterviewModule,
  ],
  providers: [
    // Apply ThrottlerGuard globally; auth controller overrides limits per endpoint
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
