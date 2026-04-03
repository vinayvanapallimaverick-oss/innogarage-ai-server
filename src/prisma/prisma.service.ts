import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    // Ensure the connection pool is explicitly sized for concurrent users.
    // Default Prisma pool = num_cpus * 2 + 1 which is often too small (3-5)
    // on Railway single-vCPU containers.
    // Configurable via DB_POOL_SIZE env var; defaults to 20.
    // Free-tier Neon caps at ~25 connections — 20 leaves some headroom.
    // If using Neon's pooled connection string (pgbouncer), you can set higher.
    const rawUrl = process.env.DATABASE_URL || '';
    const poolSize = parseInt(process.env.DB_POOL_SIZE || '20', 10);
    const separator = rawUrl.includes('?') ? '&' : '?';
    const pooledUrl = rawUrl.includes('connection_limit')
      ? rawUrl
      : `${rawUrl}${separator}connection_limit=${poolSize}&pool_timeout=30`;

    super({
      datasources: { db: { url: pooledUrl } },
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('Database connected');
    } catch (err) {
      // DB unreachable at startup — server still runs, DB calls will fail individually
      this.logger.warn(`Database connection failed at startup: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

