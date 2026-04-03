import {
  Controller,
  Post,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Req,
  Res,
  Logger,
  Request,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response, Request as ExpressRequest } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { InterviewService } from './interview.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SubscriptionGuard } from '../subscription/guards/subscription.guard';
import { ScreenAnalyzeDto, AnalyzeDto } from './dto/interview.dto';

// Skip the global per-IP rate limiter for interview endpoints.
// Interview sessions generate ~44 req/min per user (audio chunks + analyze + screen).
// Per-IP throttling would block any 2 users behind the same NAT.
// These endpoints are already protected by JwtAuthGuard + SubscriptionGuard +
// the per-user concurrency limiter inside InterviewService.
@SkipThrottle()
@Controller('interview')
export class InterviewController {
  private readonly logger = new Logger(InterviewController.name);
  constructor(private interviewService: InterviewService) {}

  @Post('transcribe')
  @UseGuards(JwtAuthGuard, SubscriptionGuard)
  @UseInterceptors(FileInterceptor('audio'))
  async transcribe(
    @UploadedFile() file: Express.Multer.File,
    @Request() req: any,
  ) {
    if (!file) throw new BadRequestException('No audio file provided');
    if (file.buffer.length < 500) return { text: '' };

    const userId: string | undefined = req.user?.sub;

    try {
      return await this.interviewService.transcribeAudio(
        file.buffer,
        file.originalname || 'chunk.webm',
        userId,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Transcription failed: ${msg}`);
      throw new BadRequestException(`Transcription failed: ${msg.slice(0, 300)}`);
    }
  }

  @Post('analyze')
  @UseGuards(JwtAuthGuard, SubscriptionGuard)
  async analyzeAndAnswer(
    @Body() body: AnalyzeDto,
    @Res() res: Response,
    @Request() req: any,
  ) {
    if (!body.transcript) throw new BadRequestException('No transcript provided');

    const userId: string | undefined = req.user?.sub;

    // Abort the AI stream immediately when the client disconnects
    // so we stop wasting API credits and free the per-user slot.
    const ac = new AbortController();
    res.on('close', () => ac.abort());

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      for await (const event of this.interviewService.analyzeAndAnswer(
        body.transcript,
        body.profile || {},
        body.history || [],
        body.intent,
        body.memory,
        userId,
        ac.signal,
      )) {
        if (ac.signal.aborted) break;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      if (!ac.signal.aborted) res.write('data: [DONE]\n\n');
    } catch (err) {
      if ((err as any)?.name !== 'AbortError') {
        this.logger.error('analyzeAndAnswer stream error', err instanceof Error ? err.message : String(err));
        if (!ac.signal.aborted) {
          res.write(`data: ${JSON.stringify({ type: 'skip' })}\n\n`);
        }
      }
    } finally {
      res.end();
    }
  }

  @Post('screen-analyze')
  @UseGuards(JwtAuthGuard, SubscriptionGuard)
  async streamScreenAnalysis(
    @Body() body: ScreenAnalyzeDto,
    @Res() res: Response,
    @Request() req: any,
  ) {
    if (!body.image) {
      throw new BadRequestException('No image provided');
    }

    const userId: string | undefined = req.user?.sub;

    // Abort AI vision stream when the client disconnects.
    const ac = new AbortController();
    res.on('close', () => ac.abort());

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      for await (const chunk of this.interviewService.streamScreenAnalysis(
        body.image,
        body.profile || {},
        userId,
        ac.signal,
      )) {
        if (ac.signal.aborted) break;
        res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
      }
      if (!ac.signal.aborted) res.write('data: [DONE]\n\n');
    } catch (err) {
      if ((err as any)?.name !== 'AbortError') {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[screen-analyze] Error:', msg);
        if (!ac.signal.aborted) {
          res.write(`data: ${JSON.stringify({ error: 'Screen analysis failed', detail: msg })}\n\n`);
        }
      }
    } finally {
      res.end();
    }
  }
}
