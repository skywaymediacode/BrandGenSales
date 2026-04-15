import nodemailer from 'nodemailer';
import { getAIClient } from './ai.js';
import config from './config.js';

/**
 * Email composition and sending engine.
 * Uses AI to write personalized emails matching the brand voice.
 */
export class Emailer {
  constructor() {
    this.transporter = null;
    this.sentToday = 0;
    this.sentTodayDate = null;
  }

  async initialize() {
    if (config.email.host) {
      this.transporter = nodemailer.createTransport({
        host: config.email.host,
        port: config.email.port,
        secure: config.email.port === 465,
        auth: {
          user: config.email.user,
          pass: config.email.pass,
        },
      });

      // Verify connection
      try {
        await this.transporter.verify();
      } catch (err) {
        console.warn('[Emailer] SMTP verification failed:', err.message);
        console.warn('[Emailer] Emails will be logged but not sent until SMTP is configured.');
        this.transporter = null;
      }
    }
  }

  /**
   * Compose an email using AI based on a sequence step, contact data, and brand voice.
   * @param {object} step - Sequence step definition (template, stepIndex, etc.)
   * @param {object} contact - Contact record
   * @param {object} brand - Brand context
   * @returns {{ subject: string, body: string, subjectAlt: string }}
   */
  async compose(step, contact, brand) {
    const ai = getAIClient();

    const brandVoice = brand?.intake?.brandVoice || brand?.intake?.tone || 'professional and friendly';
    const brandName = brand?.name || brand?.intake?.businessName || 'Our Company';
    const offerings = brand?.intake?.services || brand?.intake?.offerings || '';

    const prompt = `You are writing a sales email for ${brandName}.

## Brand Voice
${brandVoice}

## Brand Offerings
${offerings || 'Marketing and business growth services'}

## Recipient
- Name: ${contact.firstName || ''} ${contact.lastName || ''}
- Company: ${contact.company || 'their business'}
- Industry: ${contact.industry || ''}
- Title: ${contact.title || ''}
- Notes: ${contact.notes || 'No additional context'}

## Email Context
- Sequence: ${step.sequenceKey || 'cold-outreach'}
- Step: ${step.stepIndex !== undefined ? step.stepIndex + 1 : 1}
- Template type: ${step.template || 'intro'}

## Instructions
Write a concise, personalized sales email. Include:
1. A compelling subject line
2. An alternative subject line for A/B testing
3. The email body (plain text, 3-5 short paragraphs max)
4. A clear call-to-action

Be conversational, not salesy. Reference the recipient's business specifically.
Do NOT use placeholder text like [Your Name] — use "${brandName}" as the sender.

Respond with JSON:
{
  "subject": "<subject line>",
  "subjectAlt": "<alternative subject line>",
  "body": "<email body text>"
}`;

    try {
      const result = await ai.generateJSON(prompt);
      return {
        subject: result.subject,
        subjectAlt: result.subjectAlt || result.subject,
        body: result.body,
      };
    } catch (err) {
      console.error('[Emailer] AI composition failed:', err.message);
      return this.fallbackCompose(step, contact, brand);
    }
  }

  /**
   * Fallback template-based composition when AI is unavailable.
   */
  fallbackCompose(step, contact, brand) {
    const brandName = brand?.name || brand?.intake?.businessName || 'Our Company';
    const firstName = contact.firstName || 'there';
    const company = contact.company || 'your business';

    const templates = {
      intro: {
        subject: `Quick question about ${company}`,
        subjectAlt: `Ideas for ${company}'s growth`,
        body: `Hi ${firstName},\n\nI came across ${company} and was impressed by what you're building.\n\nAt ${brandName}, we help businesses like yours grow through strategic marketing and outreach. I'd love to learn more about your goals and see if we might be a good fit.\n\nWould you be open to a quick 15-minute call this week?\n\nBest,\n${brandName}`,
      },
      'follow-up': {
        subject: `Following up — ${company}`,
        subjectAlt: `Still thinking about ${company}`,
        body: `Hi ${firstName},\n\nI reached out last week about how ${brandName} could help ${company} grow. I know things get busy, so I wanted to follow up.\n\nWe've helped similar businesses increase their reach significantly. I'd be happy to share some specifics.\n\nIs there a good time to connect?\n\nBest,\n${brandName}`,
      },
      'case-study': {
        subject: `How we helped a business like ${company}`,
        subjectAlt: `Results that might interest ${company}`,
        body: `Hi ${firstName},\n\nI wanted to share a quick win from one of our clients in a similar space. They saw measurable growth within the first 90 days of working with us.\n\nI think we could achieve similar results for ${company}.\n\nWould you like to see the full case study?\n\nBest,\n${brandName}`,
      },
      'break-up': {
        subject: `Closing the loop on ${company}`,
        subjectAlt: `Last note from ${brandName}`,
        body: `Hi ${firstName},\n\nI've reached out a few times and haven't heard back — no worries at all. I understand timing is everything.\n\nIf growing ${company}'s presence ever becomes a priority, I'd love to be a resource. Feel free to reach out anytime.\n\nWishing you all the best,\n${brandName}`,
      },
    };

    const template = templates[step.template] || templates.intro;
    return { ...template };
  }

  /**
   * Send an email through the configured SMTP transport.
   */
  async send(emailPayload) {
    this.resetDailyCountIfNeeded();

    if (this.sentToday >= config.agent.maxEmailsPerDay) {
      throw new Error(`Daily email limit reached (${config.agent.maxEmailsPerDay}). Will resume tomorrow.`);
    }

    // Check unsubscribe/blacklist
    if (emailPayload.to && this.isBlacklisted(emailPayload.to)) {
      console.warn(`[Emailer] Skipping blacklisted address: ${emailPayload.to}`);
      return { sent: false, reason: 'blacklisted' };
    }

    if (!this.transporter) {
      console.log('[Emailer] No SMTP configured. Email logged but not sent.');
      console.log(`  To: ${emailPayload.to}`);
      console.log(`  Subject: ${emailPayload.subject}`);
      console.log(`  Body: ${emailPayload.body?.substring(0, 200)}...`);
      return { sent: false, reason: 'no_smtp' };
    }

    const mailOptions = {
      from: `"${config.email.fromName}" <${config.email.fromEmail}>`,
      to: emailPayload.to,
      subject: emailPayload.subject,
      text: emailPayload.body,
    };

    const result = await this.transporter.sendMail(mailOptions);
    this.sentToday++;

    return {
      sent: true,
      messageId: result.messageId,
      sentCount: this.sentToday,
    };
  }

  resetDailyCountIfNeeded() {
    const today = new Date().toISOString().split('T')[0];
    if (this.sentTodayDate !== today) {
      this.sentToday = 0;
      this.sentTodayDate = today;
    }
  }

  isBlacklisted(_email) {
    // In production, check against a persistent blacklist / unsubscribe list
    return false;
  }
}
