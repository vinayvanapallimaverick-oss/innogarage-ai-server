import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  Res,
  UseGuards,
  Request,
  Headers,
  RawBodyRequest,
  ForbiddenException,
} from '@nestjs/common';
import { SubscriptionService } from './subscription.service';
import { CreateCheckoutDto } from './dto/subscription.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Request as ExpressRequest, Response } from 'express';

@Controller('subscription')
export class SubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @UseGuards(JwtAuthGuard)
  @Post('checkout')
  async createCheckout(
    @Request() req: any,
    @Body() dto: CreateCheckoutDto,
  ) {
    return this.subscriptionService.createCheckoutSession(req.user.sub, dto.plan);
  }

  @UseGuards(JwtAuthGuard)
  @Post('activate')
  async activatePlan(
    @Request() req: any,
    @Body() dto: CreateCheckoutDto,
  ) {
    return this.subscriptionService.activatePlanDirectly(req.user.sub, dto.plan);
  }

  @Post('webhook')
  async webhook(
    @Req() req: RawBodyRequest<ExpressRequest>,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!req.rawBody) {
      throw new ForbiddenException('Missing request body');
    }
    return this.subscriptionService.handleWebhook(req.rawBody, signature);
  }

  @UseGuards(JwtAuthGuard)
  @Get('status')
  async getStatus(@Request() req: any) {
    return this.subscriptionService.getSubscription(req.user.sub);
  }

  @Get('success')
  async success(
    @Query('session_id') sessionId: string,
    @Res() res: Response,
  ) {
    if (sessionId) {
      await this.subscriptionService.verifySession(sessionId);
    }
    // Return a simple HTML page that tells the Electron app to close this window
    res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Payment Successful</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0;">
          <h1 style="color:#4ade80;">&#10003; Payment Successful!</h1>
          <p>Your plan has been activated. You can close this window and return to the app.</p>
        </body>
      </html>
    `);
  }

  @Get('cancel')
  async cancel(@Res() res: Response) {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Payment Cancelled</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0;">
          <h1 style="color:#f87171;">Payment Cancelled</h1>
          <p>No charge was made. You can close this window and return to the app.</p>
        </body>
      </html>
    `);
  }
}
