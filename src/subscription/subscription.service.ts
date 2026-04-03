import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';

const PLAN_CONFIG: Record<string, { price: number; label: string; durationMs: number }> = {
  day:   { price: 1000,  label: '1 Day Access',   durationMs: 24 * 60 * 60 * 1000 },
  week:  { price: 5000,  label: '1 Week Access',  durationMs: 7 * 24 * 60 * 60 * 1000 },
  month: { price: 15000, label: '1 Month Access',  durationMs: 30 * 24 * 60 * 60 * 1000 },
};

@Injectable()
export class SubscriptionService {
  private stripe: Stripe;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY', '');
    this.stripe = new Stripe(secretKey, { apiVersion: '2026-02-25.clover' });
  }

  async createCheckoutSession(userId: string, plan: string) {
    const planConfig = PLAN_CONFIG[plan];
    if (!planConfig) {
      throw new BadRequestException('Invalid plan');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('User not found');
    }

    const successUrl = this.configService.get<string>(
      'STRIPE_SUCCESS_URL',
      'http://localhost:3001/subscription/success?session_id={CHECKOUT_SESSION_ID}',
    );
    const cancelUrl = this.configService.get<string>(
      'STRIPE_CANCEL_URL',
      'http://localhost:3001/subscription/cancel',
    );

    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: user.email,
      metadata: { userId, plan },
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: `innogarage.ai — ${planConfig.label}` },
            unit_amount: planConfig.price,
          },
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return { sessionId: session.id, url: session.url };
  }

  async handleWebhook(rawBody: Buffer, signature: string) {
    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET', '');

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err: any) {
      throw new BadRequestException(`Webhook signature verification failed: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      await this.activateSubscription(session);
    }

    return { received: true };
  }

  private async activateSubscription(session: Stripe.Checkout.Session) {
    const userId = session.metadata?.userId;
    const plan = session.metadata?.plan;

    if (!userId || !plan) return;

    const planConfig = PLAN_CONFIG[plan];
    if (!planConfig) return;

    const paymentIntent =
      typeof session.payment_intent === 'string' ? session.payment_intent : '';
    const expiresAt = new Date(Date.now() + planConfig.durationMs);

    await this.prisma.subscription.upsert({
      where: { userId },
      create: {
        userId,
        plan,
        status: 'active',
        stripeSessionId: session.id,
        stripePaymentIntent: paymentIntent,
        amountPaid: planConfig.price,
        expiresAt,
      },
      update: {
        plan,
        status: 'active',
        stripeSessionId: session.id,
        stripePaymentIntent: paymentIntent,
        amountPaid: planConfig.price,
        expiresAt,
      },
    });
  }

  async getSubscription(userId: string) {
    const sub = await this.prisma.subscription.findUnique({
      where: { userId },
    });

    if (!sub) return null;

    // Check if expired (use transaction to avoid race condition)
    if (sub.expiresAt < new Date()) {
      const updated = await this.prisma.$transaction(async (tx) => {
        const current = await tx.subscription.findUnique({ where: { id: sub.id } });
        if (!current || current.status === 'expired') return current;
        return tx.subscription.update({
          where: { id: sub.id },
          data: { status: 'expired' },
        });
      });
      return updated ? { ...updated, status: 'expired' } : { ...sub, status: 'expired' };
    }

    return sub;
  }

  /**
   * Called by the success redirect — polls the session to activate
   * even if webhook hasn't arrived yet (useful for local dev without webhook).
   */
  async verifySession(sessionId: string) {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status === 'paid') {
      await this.activateSubscription(session);
      return { activated: true };
    }
    return { activated: false };
  }

  async activatePlanDirectly(userId: string, plan: string) {
    const planConfig = PLAN_CONFIG[plan];
    if (!planConfig) {
      throw new BadRequestException('Invalid plan');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('User not found');
    }

    const expiresAt = new Date(Date.now() + planConfig.durationMs);

    const subscription = await this.prisma.subscription.upsert({
      where: { userId },
      create: {
        userId,
        plan,
        status: 'active',
        amountPaid: 0,
        expiresAt,
      },
      update: {
        plan,
        status: 'active',
        amountPaid: 0,
        expiresAt,
      },
    });

    return subscription;
  }
}
