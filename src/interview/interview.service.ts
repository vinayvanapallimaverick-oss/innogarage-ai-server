import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

export interface ProfileContext {
  prompt?: string;
  companyName?: string;
  role?: string;
  experience?: string;
  interviewType?: string;
  resumeText?: string;
}

export interface HistoryItem {
  question: string;
  answer: string;
}

@Injectable()
export class InterviewService implements OnModuleDestroy {
  private readonly genAI: GoogleGenerativeAI;
  private readonly deepgramApiKey: string;
  private readonly logger = new Logger(InterviewService.name);

  // ── Per-user concurrency limiter ──────────────────────────────────────────
  private readonly userConcurrency = new Map<string, number>();
  private readonly maxConcurrentPerUser = 5;

  // ── Global server-wide concurrency limiter ────────────────────────────────
  private globalInFlight = 0;
  private readonly maxGlobalConcurrent: number;

  // ── Stale slot recovery ───────────────────────────────────────────────────
  private readonly slotAcquiredAt = new Map<string, number[]>();
  private readonly slotTTLMs = 120_000;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly configService: ConfigService) {
    const geminiKey = this.configService.get<string>('GEMINI_API_KEY');
    const deepgramKey = this.configService.get<string>('DEEPGRAM_API_KEY');

    if (!geminiKey) {
      this.logger.error('GEMINI_API_KEY is not set — Gemini analysis will fail');
    }
    if (!deepgramKey) {
      this.logger.error('DEEPGRAM_API_KEY is not set — Deepgram transcription will fail');
    }

    this.genAI = new GoogleGenerativeAI(geminiKey || '');
    this.deepgramApiKey = deepgramKey || '';

    this.maxGlobalConcurrent = parseInt(
      this.configService.get<string>('MAX_GLOBAL_CONCURRENT_AI', '40'),
      10,
    );

    // Purge stuck slots every 60 seconds
    this.cleanupTimer = setInterval(() => this.purgeStaleSlots(), 60_000);
  }

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
  }

  /** Try to reserve a slot for userId. Returns false if at per-user or global limit. */
  private acquireSlot(userId: string): boolean {
    if (this.globalInFlight >= this.maxGlobalConcurrent) {
      this.logger.warn(
        `Global concurrency limit reached (${this.globalInFlight}/${this.maxGlobalConcurrent}) — throttling user ${userId}`,
      );
      return false;
    }
    const current = this.userConcurrency.get(userId) || 0;
    if (current >= this.maxConcurrentPerUser) return false;

    this.userConcurrency.set(userId, current + 1);
    this.globalInFlight++;

    // Track acquisition time for stale cleanup
    const timestamps = this.slotAcquiredAt.get(userId) || [];
    timestamps.push(Date.now());
    this.slotAcquiredAt.set(userId, timestamps);

    return true;
  }

  /** Release a slot after the AI call completes or aborts. */
  private releaseSlot(userId: string): void {
    const current = this.userConcurrency.get(userId) || 0;
    if (current <= 1) {
      this.userConcurrency.delete(userId);
      this.slotAcquiredAt.delete(userId);
    } else {
      this.userConcurrency.set(userId, current - 1);
      // Remove the oldest timestamp (FIFO)
      const timestamps = this.slotAcquiredAt.get(userId);
      if (timestamps?.length) timestamps.shift();
    }
    this.globalInFlight = Math.max(0, this.globalInFlight - 1);
  }

  /**
   * Periodically free slots that have been held longer than slotTTLMs.
   * Protects against edge cases where an AI call hangs or a request crashes
   * without reaching the finally block.
   */
  private purgeStaleSlots(): void {
    const now = Date.now();
    let purgedTotal = 0;

    for (const [userId, timestamps] of this.slotAcquiredAt) {
      const staleCount = timestamps.filter((t) => now - t > this.slotTTLMs).length;
      if (staleCount === 0) continue;

      purgedTotal += staleCount;
      const current = this.userConcurrency.get(userId) || 0;
      const newCount = Math.max(0, current - staleCount);
      this.globalInFlight = Math.max(0, this.globalInFlight - staleCount);

      if (newCount === 0) {
        this.userConcurrency.delete(userId);
        this.slotAcquiredAt.delete(userId);
      } else {
        this.userConcurrency.set(userId, newCount);
        this.slotAcquiredAt.set(
          userId,
          timestamps.filter((t) => now - t <= this.slotTTLMs),
        );
      }
    }

    if (purgedTotal > 0) {
      this.logger.warn(
        `Purged ${purgedTotal} stale slot(s). Active users: ${this.userConcurrency.size}, global in-flight: ${this.globalInFlight}`,
      );
    }
  }

  // ─── 1. Transcribe audio chunk via Deepgram Nova-2 ─────────────────────────

  async transcribeAudio(
    buffer: Buffer,
    originalName: string,
    userId?: string,
    signal?: AbortSignal,
  ): Promise<{ text: string }> {
    if (userId && !this.acquireSlot(userId)) {
      this.logger.warn(`User ${userId} exceeded concurrent request limit (transcribe)`);
      return { text: '' };
    }
    try {
      const extMatch = originalName.match(/\.(\w+)$/);
      const ALLOWED_AUDIO_EXTS = ['webm', 'ogg', 'mp3', 'mp4', 'wav', 'm4a', 'flac'];
      const ext =
        extMatch && ALLOWED_AUDIO_EXTS.includes(extMatch[1].toLowerCase())
          ? extMatch[1].toLowerCase()
          : 'webm';

      const response = await fetch(
        'https://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true',
        {
          method: 'POST',
          headers: {
            Authorization: `Token ${this.deepgramApiKey}`,
            'Content-Type': `audio/${ext}`,
          },
          body: new Uint8Array(buffer),
          ...(signal ? { signal } : {}),
        },
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Deepgram error ${response.status}: ${errText.slice(0, 200)}`);
      }

      const data = await response.json();
      const text =
        data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || '';
      return { text };
    } finally {
      if (userId) this.releaseSlot(userId);
    }
  }

  // ─── 2. Analyze transcript: detect question + stream answer (Gemini) ─────
  //
  // Single Gemini call. Streams events in the wire format:
  //   { type: 'skip' }
  //   { type: 'question', text: '...' }
  //   { type: 'answer',   text: '...' }   (streaming tokens)

  async *analyzeAndAnswer(
    transcript: string,
    profile: ProfileContext,
    history: HistoryItem[],
    intent?: string,
    memory?: { shortTerm?: HistoryItem[]; summary?: string; topics?: string[] },
    userId?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<{ type: 'question' | 'answer' | 'skip'; text?: string }> {
    if (userId && !this.acquireSlot(userId)) {
      this.logger.warn(`User ${userId} exceeded concurrent request limit (analyze)`);
      yield { type: 'skip' };
      return;
    }
    try {
      const systemPrompt = this.buildAnalyzePrompt(profile, history, intent, memory);

      const model = this.genAI.getGenerativeModel({
        model: 'gemini-2.0-flash',
        systemInstruction: systemPrompt,
        generationConfig: { maxOutputTokens: 1200, temperature: 0.35 },
      });

      const result = await model.generateContentStream(transcript);

      const ANSWER_MARKER = '\nANSWER:';
      let headerBuf = '';
      let headerDone = false;
      let skipDetected = false;

      for await (const chunk of result.stream) {
        if (signal?.aborted) break;
        const delta = chunk.text();
        if (!delta) continue;

        if (!headerDone) {
          headerBuf += delta;

          if (headerBuf.trimStart().toUpperCase().startsWith('SKIP')) {
            skipDetected = true;
            headerDone = true;
            yield { type: 'skip' };
            return;
          }

          const sepIdx = headerBuf.indexOf(ANSWER_MARKER);
          if (sepIdx !== -1) {
            headerDone = true;
            const questionText = headerBuf
              .slice(0, sepIdx)
              .replace(/^QUESTION:\s*/i, '')
              .trim();
            yield { type: 'question', text: questionText };
            const earlyAnswer = headerBuf.slice(sepIdx + ANSWER_MARKER.length);
            if (earlyAnswer.trim()) yield { type: 'answer', text: earlyAnswer };
          }
        } else if (!skipDetected) {
          yield { type: 'answer', text: delta };
        }
      }
    } finally {
      if (userId) this.releaseSlot(userId);
    }
  }

  // ─── 3. Screen content analysis via Gemini vision ─────────────────────────

  async *streamScreenAnalysis(
    imageBase64: string,
    profile: ProfileContext,
    userId?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    if (userId && !this.acquireSlot(userId)) {
      this.logger.warn(`User ${userId} exceeded concurrent request limit (screen-analyze)`);
      return;
    }
    this.logger.debug(
      `Starting screen analysis: imageLength=${imageBase64.length}, role=${profile.role || 'unknown'}`,
    );

    const profileParts: string[] = [];
    if (profile.role) profileParts.push(`Role: ${profile.role}`);
    if (profile.companyName) profileParts.push(`Company: ${profile.companyName}`);
    if (profile.experience) profileParts.push(`Experience: ${profile.experience}`);
    if (profile.interviewType) profileParts.push(`Interview type: ${profile.interviewType}`);

    const systemPrompt = [
      "You are an expert interview assistant analyzing a candidate's screen during a live interview.",
      profileParts.length > 0 ? `\nCandidate context:\n${profileParts.join('\n')}\n` : '',
      'Rules:',
      '- Provide ONLY the direct, actionable suggestion based on what is visible on screen.',
      '- Be precise and concise — no filler, no introductions, no generic advice.',
      '- If you see code, provide the specific fix, improvement, or solution directly.',
      '- If you see a question or problem, provide the direct answer or solution.',
      "- Do NOT add labels like \"Suggestion:\" or \"Here's what I see:\" — just give the content.",
      '- Do NOT provide general interview tips unrelated to screen content.',
      '- Do NOT repeat or rephrase what is already visible on screen.',
      '- If the screen shows nothing meaningful or hasn\'t changed, respond with exactly "NO_UPDATE".',
      '- Do not mention that you are an AI.',
      '- Keep your response focused and minimal.',
    ].join('\n');

    try {
      const model = this.genAI.getGenerativeModel({
        model: 'gemini-2.0-flash',
        systemInstruction: systemPrompt,
        generationConfig: { maxOutputTokens: 512, temperature: 0.5 },
      });

      // Extract base64 data and mime type from data URL
      const dataUrlMatch = imageBase64.match(/^data:image\/(\w+);base64,(.+)$/);
      let mimeType: string;
      let base64Data: string;
      if (dataUrlMatch) {
        mimeType = `image/${dataUrlMatch[1]}`;
        base64Data = dataUrlMatch[2];
      } else {
        // Assume raw base64 JPEG if no data URL prefix
        mimeType = 'image/jpeg';
        base64Data = imageBase64;
      }

      const result = await model.generateContentStream({
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType, data: base64Data } },
              {
                text: 'Analyze this screen and provide contextual suggestions for the interview candidate.',
              },
            ],
          },
        ],
      });

      let chunkCount = 0;
      for await (const chunk of result.stream) {
        if (signal?.aborted) break;
        const delta = chunk.text();
        if (delta) {
          chunkCount += 1;
          yield delta;
        }
      }
      this.logger.debug(`Screen analysis completed with ${chunkCount} streamed chunks`);
    } catch (err) {
      if ((err as any)?.name === 'AbortError') {
        this.logger.debug('Screen analysis aborted (client disconnected)');
        return;
      }
      this.logger.error(
        'Screen analysis failed',
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    } finally {
      if (userId) this.releaseSlot(userId);
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private buildAnalyzePrompt(
    profile: ProfileContext,
    history: HistoryItem[],
    intent?: string,
    memory?: { shortTerm?: HistoryItem[]; summary?: string; topics?: string[] },
  ): string {
    const parts: string[] = [];

    // ── Core instruction + format ──
    parts.push(`You are a live AI interview copilot. You answer ON BEHALF of the candidate in real time.

═══════════════════════════════
RESPONSE FORMAT — output exactly one:

  SKIP

  — or —

  QUESTION: <cleaned, grammatically correct version of the question>
  ANSWER: <your first-person answer as the candidate>

WHEN TO ANSWER:
- Direct questions: "What is your experience with X?", "How would you handle Y?"
- Implied prompts: "Tell me about...", "Walk me through...", "Describe a time..."
- Technical questions, design questions, coding problems
- Follow-up questions (use conversation context)
- Conversational prompts that expect a response

WHEN TO SKIP:
- Background noise, filler ("uh", "hmm", "okay", "right", "yeah")
- Incomplete fragments clearly cut off mid-sentence
- Side conversations not directed at the candidate
- Pure factual statements with no question or prompt implied`);

    // ── Intent classification (provided by client-side detector) ──
    if (intent && intent !== 'filler' && intent !== 'noise') {
      parts.push(`\nINPUT CLASSIFICATION: ${intent.toUpperCase()}\n(use this to adjust your response — follow-ups should reference prior exchanges)`);
    }

    // ── Conversation context — prefer structured memory over flat history ──
    const shortTerm = memory?.shortTerm?.length ? memory.shortTerm : history.slice(-3);
    if (memory?.summary) {
      parts.push(`\nCONVERSATION SUMMARY (prior session context):\n${memory.summary}`);
    }
    if (memory?.topics?.length) {
      parts.push(`\nTOPICS ALREADY COVERED: ${memory.topics.join(', ')}\n(do not repeat or re-explain these — build on them if asked)`);
    }
    if (shortTerm.length > 0) {
      parts.push(
        `\nRECENT EXCHANGES (verbatim — use for follow-up accuracy):\n` +
          shortTerm
            .map((h) => `Q: ${h.question}\nA: ${h.answer}`)
            .join('\n\n'),
      );
    }

    // ── Candidate profile ──
    const profileLines: string[] = [];
    if (profile.role) profileLines.push(`Role applying for: ${profile.role}`);
    if (profile.companyName) profileLines.push(`Company: ${profile.companyName}`);
    if (profile.experience) profileLines.push(`Experience level: ${profile.experience}`);
    if (profile.interviewType) profileLines.push(`Interview type: ${profile.interviewType}`);
    if (profile.resumeText) {
      profileLines.push(`\nRESUME (ground ALL answers in this — do not invent experience):\n${profile.resumeText.slice(0, 2500)}`);
    }
    if (profileLines.length > 0) {
      parts.push(`\nCANDIDATE PROFILE:\n${profileLines.join('\n')}`);
    }
    if (profile.prompt) {
      parts.push(`\nSPECIAL INSTRUCTIONS FROM CANDIDATE (follow closely):\n${profile.prompt}`);
    }

    // ── Answer rules ──
    parts.push(`
ANSWER WRITING RULES:
- First person ("I", "my", "I've")
- 50–150 words — concise, natural, interview-ready
- No opener filler: "Great question!", "Sure!", "Of course!", "Absolutely!"
- Do not restate or echo the question
- Behavioral questions → STAR method (Situation, Task, Action, Result)
- Technical questions → approach first, then trade-offs, then edge cases
- Follow-up questions → explicitly reference your prior answer
- Ground answers in the candidate's actual resume/profile
- Infer missing context from role/company if resume is absent — stay realistic
- Do not invent experience or skills not present in the profile
- Sound confident and human — not robotic
- Do not mention you are AI`);

    return parts.join('\n');
  }
}
