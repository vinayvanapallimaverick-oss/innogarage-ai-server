import { Injectable, BadRequestException, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

const SEND_TIMEOUT_MS = 15_000;
type MailMode = 'gmail' | 'resend' | 'smtp' | 'console';

@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private mode: MailMode = 'console';

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const gmailToken = this.configService.get<string>('GMAIL_REFRESH_TOKEN');
    const resendKey  = this.configService.get<string>('RESEND_API_KEY');
    const smtpUser   = this.configService.get<string>('SMTP_USER');

    if (gmailToken) {
      this.mode = 'gmail';
      this.logger.log('Mail => Gmail REST API (HTTPS)');
    } else if (resendKey) {
      this.mode = 'resend';
      this.logger.log('Mail => Resend HTTP API');
    } else if (smtpUser) {
      this.mode = 'smtp';
      const port = this.configService.get<number>('SMTP_PORT', 465);
      this.transporter = nodemailer.createTransport({
        host: this.configService.get<string>('SMTP_HOST', 'smtp.gmail.com'),
        port,
        secure: port === 465,
        auth: { user: smtpUser, pass: this.configService.get<string>('SMTP_PASS') },
        connectionTimeout: 10_000,
        greetingTimeout:   10_000,
        socketTimeout:     15_000,
      });
      this.logger.warn('Mail => SMTP (may be blocked on cloud platforms)');
    } else {
      this.logger.warn('Mail => console only (set GMAIL_REFRESH_TOKEN to enable real email)');
    }
  }

  async sendOtp(email: string, code: string): Promise<void> {
    const html = this.buildHtml(code);
    switch (this.mode) {
      case 'gmail':  return this.sendViaGmail(email, html);
      case 'resend': return this.sendViaResend(email, html);
      case 'smtp':   return this.sendViaSmtp(email, html);
      default:
        this.logger.log(`[DEV] OTP for ${email}: ${code}`);
    }
  }

  /** Returns true when a real email transport is configured (Gmail/Resend/SMTP) */
  isEmailConfigured(): boolean {
    return this.mode !== 'console';
  }

  private async sendViaGmail(email: string, html: string): Promise<void> {
    const clientId     = this.configService.get<string>('GOOGLE_CLIENT_ID')!;
    const clientSecret = this.configService.get<string>('GOOGLE_CLIENT_SECRET')!;
    const refreshToken = this.configService.get<string>('GMAIL_REFRESH_TOKEN')!;
    const fromEmail    = this.configService.get<string>('GMAIL_FROM')!;

    try {
      const tokenRes = await this.timedFetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId, client_secret: clientSecret,
          refresh_token: refreshToken, grant_type: 'refresh_token',
        }).toString(),
      }, 10_000);

      if (!tokenRes.ok) {
        const e = await tokenRes.json().catch(() => ({})) as any;
        throw new Error(`Token refresh: ${e?.error_description || tokenRes.status}`);
      }
      const { access_token } = await tokenRes.json() as { access_token: string };

      const raw = Buffer.from(
        `From: "innogarage.ai" <${fromEmail}>\r\n` +
        `To: ${email}\r\n` +
        `Subject: Your innogarage.ai Verification Code\r\n` +
        `MIME-Version: 1.0\r\n` +
        `Content-Type: text/html; charset=UTF-8\r\n\r\n` +
        html,
      ).toString('base64url');

      const sendRes = await this.timedFetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw }),
        },
        SEND_TIMEOUT_MS,
      );

      if (!sendRes.ok) {
        const e = await sendRes.json().catch(() => ({})) as any;
        throw new Error(e?.error?.message || `Gmail API: ${sendRes.status}`);
      }
    } catch (err: any) {
      this.logger.error(`Gmail API failed for ${email}: ${err?.message}`);
      throw new BadRequestException('Unable to send verification email right now. Please try again in a moment.');
    }
  }

  private async sendViaResend(email: string, html: string): Promise<void> {
    const apiKey   = this.configService.get<string>('RESEND_API_KEY')!;
    const fromAddr = this.configService.get<string>('RESEND_FROM', 'innogarage.ai <onboarding@resend.dev>');
    try {
      const res = await this.timedFetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: fromAddr, to: email, subject: 'Your innogarage.ai Verification Code', html }),
      }, SEND_TIMEOUT_MS);
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as any;
        throw new Error(b?.message || `Resend: ${res.status}`);
      }
    } catch (err: any) {
      this.logger.error(`Resend failed for ${email}: ${err?.message}`);
      throw new BadRequestException('Unable to send verification email right now. Please try again in a moment.');
    }
  }

  private async sendViaSmtp(email: string, html: string): Promise<void> {
    const from = this.configService.get<string>('SMTP_USER')!;
    try {
      await Promise.race([
        this.transporter!.sendMail({
          from: `"innogarage.ai" <${from}>`, to: email,
          subject: 'Your innogarage.ai Verification Code', html,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('SMTP timed out')), SEND_TIMEOUT_MS)),
      ]);
    } catch (err: any) {
      this.logger.error(`SMTP failed for ${email}: ${err?.message}`);
      throw new BadRequestException('Unable to send verification email right now. Please try again in a moment.');
    }
  }

  private async timedFetch(url: string, init: RequestInit, ms: number): Promise<Response> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try { return await fetch(url, { ...init, signal: ctrl.signal }); }
    finally { clearTimeout(t); }
  }

  private buildHtml(code: string): string {
    return `
      <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#6366f1;margin-bottom:8px">innogarage.ai</h2>
        <p style="color:#374151;font-size:16px">Your verification code is:</p>
        <div style="background:linear-gradient(135deg,#6366f1,#a855f7);color:white;padding:16px 32px;
          border-radius:12px;text-align:center;font-size:32px;letter-spacing:8px;font-weight:bold;margin:24px 0">
          ${code}
        </div>
        <p style="color:#6b7280;font-size:14px">This code expires in 10 minutes. Do not share it with anyone.</p>
      </div>`;
  }
}
