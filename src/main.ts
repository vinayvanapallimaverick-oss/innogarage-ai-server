// Must be the very first import so the File polyfill loads before any OpenAI code
import './polyfills';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { AppModule } from './app.module';
import { mkdirSync } from 'fs';
import { join } from 'path';
import * as express from 'express';

async function bootstrap() {
  // Ensure uploads directory exists
  mkdirSync(join(__dirname, '..', 'uploads', 'resumes'), { recursive: true });

  // Disable built-in body parser so we can set a custom limit
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Custom body parsers with 10MB limit for base64 screen captures
  // verify callback populates req.rawBody so Stripe webhook signature can be checked
  app.use(express.json({
    limit: '10mb',
    verify: (req: any, _res: any, buf: Buffer) => {
      req.rawBody = buf;
    },
  }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  app.enableCors({
    // Allow Electron renderer (app://localhost from packaged .exe),
    // null-origin fallback for older builds (file:// protocol), and localhost dev servers.
    origin: (origin, callback) => {
      if (
        !origin ||
        origin === 'null' ||
        /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
        origin === 'app://localhost'  // Electron production app custom protocol
      ) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      exceptionFactory: (errors) => {
        console.error('[ValidationPipe] 400 errors:', JSON.stringify(errors, null, 2));
        return new BadRequestException(errors);
      },
    }),
  );

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`Server running on http://localhost:${port}`);

  // Graceful shutdown — let in-flight SSE streams and DB transactions finish
  // before the process exits on SIGTERM (Railway sends this on redeploy).
  app.enableShutdownHooks();
}
bootstrap();
