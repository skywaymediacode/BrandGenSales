import { getAIClient } from './ai.js';
import config from './config.js';

/**
 * Lead qualification engine.
 * Scores leads 0-100 based on fit, intent, budget, timing, and accessibility.
 */
export class Qualifier {
  /**
   * Qualify a contact against the brand's ideal customer profile.
   * @param {object} contact - Contact record from CRM
   * @param {object} brand - Brand context from BrandGen (intake, facts, etc.)
   * @returns {object} Qualification result with score breakdown
   */
  async qualify(contact, brand) {
    // First pass: rule-based scoring for fast results
    const ruleScore = this.ruleBasedScore(contact, brand);

    // Second pass: AI-powered scoring for nuance
    let aiScore = null;
    try {
      aiScore = await this.aiScore(contact, brand);
    } catch (err) {
      console.error('[Qualifier] AI scoring failed, using rule-based only:', err.message);
    }

    // Merge scores: AI overrides if available, otherwise use rules
    const score = aiScore || ruleScore;

    return {
      total: Math.round(score.total),
      fit: Math.round(score.fit),
      intent: Math.round(score.intent),
      budget: Math.round(score.budget),
      timing: Math.round(score.timing),
      accessibility: Math.round(score.accessibility),
      summary: score.summary,
      recommendedAction: score.recommendedAction,
      talkingPoints: score.talkingPoints || [],
      estimatedValue: score.estimatedValue || 0,
    };
  }

  /**
   * Rule-based scoring using available data fields.
   */
  ruleBasedScore(contact, brand) {
    const scores = { fit: 0, intent: 0, budget: 0, timing: 0, accessibility: 0 };

    // ── Fit (30%) ──────────────────────────────────────────────
    const targetMarket = brand?.intake?.targetMarket?.toLowerCase() || '';
    const targetIndustry = brand?.intake?.industry?.toLowerCase() || '';
    const contactIndustry = (contact.industry || contact.company || '').toLowerCase();
    const contactTags = (contact.tags || []).map((t) => t.toLowerCase());

    if (targetIndustry && contactIndustry.includes(targetIndustry)) scores.fit += 40;
    if (targetMarket && contactTags.some((t) => targetMarket.includes(t))) scores.fit += 30;
    if (contact.company) scores.fit += 15;
    if (contact.website) scores.fit += 15;
    scores.fit = Math.min(scores.fit, 100);

    // ── Intent (25%) ───────────────────────────────────────────
    if (contact.lastActivityType === 'email_open') scores.intent += 30;
    if (contact.lastActivityType === 'email_click') scores.intent += 50;
    if (contact.lastActivityType === 'form_submit') scores.intent += 60;
    if (contact.lastActivityType === 'website_visit') scores.intent += 25;
    if (contact.source === 'inbound') scores.intent += 40;
    if (contact.source === 'referral') scores.intent += 35;
    if (!contact.lastActivityType && contact.source !== 'inbound') scores.intent += 10;
    scores.intent = Math.min(scores.intent, 100);

    // ── Budget (20%) ───────────────────────────────────────────
    if (contact.companySize === 'enterprise' || contact.employees > 200) scores.budget += 50;
    else if (contact.companySize === 'mid-market' || contact.employees > 50) scores.budget += 35;
    else if (contact.companySize === 'small' || contact.employees > 10) scores.budget += 20;
    else scores.budget += 10;

    if (contact.estimatedRevenue > 5_000_000) scores.budget += 50;
    else if (contact.estimatedRevenue > 1_000_000) scores.budget += 35;
    else if (contact.estimatedRevenue > 250_000) scores.budget += 20;
    else scores.budget += 10;

    scores.budget = Math.min(scores.budget, 100);

    // ── Timing (15%) ───────────────────────────────────────────
    if (contact.notes?.toLowerCase().includes('expanding')) scores.timing += 40;
    if (contact.notes?.toLowerCase().includes('new business')) scores.timing += 40;
    if (contact.notes?.toLowerCase().includes('looking for')) scores.timing += 50;
    if (contact.notes?.toLowerCase().includes('urgent')) scores.timing += 30;
    if (contact.createdAt) {
      const daysSinceCreated = (Date.now() - new Date(contact.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceCreated < 7) scores.timing += 30;
      else if (daysSinceCreated < 30) scores.timing += 15;
    }
    scores.timing = Math.min(scores.timing, 100);

    // ── Accessibility (10%) ────────────────────────────────────
    if (contact.email) scores.accessibility += 40;
    if (contact.phone) scores.accessibility += 25;
    if (contact.linkedIn) scores.accessibility += 15;
    if (contact.title?.toLowerCase().match(/owner|ceo|founder|director|manager|president/)) {
      scores.accessibility += 20;
    }
    scores.accessibility = Math.min(scores.accessibility, 100);

    // ── Weighted total ─────────────────────────────────────────
    const total =
      scores.fit * 0.3 +
      scores.intent * 0.25 +
      scores.budget * 0.2 +
      scores.timing * 0.15 +
      scores.accessibility * 0.1;

    // Generate summary
    let recommendedAction = 'monitor';
    if (total >= 70) recommendedAction = 'immediate outreach';
    else if (total >= 50) recommendedAction = 'nurture sequence';
    else if (total >= 30) recommendedAction = 'enrich and re-evaluate';

    return {
      total,
      ...scores,
      summary: `Score ${Math.round(total)}/100. Fit: ${Math.round(scores.fit)}, Intent: ${Math.round(scores.intent)}, Budget: ${Math.round(scores.budget)}, Timing: ${Math.round(scores.timing)}, Access: ${Math.round(scores.accessibility)}. Recommend: ${recommendedAction}.`,
      recommendedAction,
      talkingPoints: [],
      estimatedValue: this.estimateDealValue(contact, brand),
    };
  }

  /**
   * AI-powered scoring for deeper qualification.
   */
  async aiScore(contact, brand) {
    const ai = getAIClient();

    const prompt = `You are a B2B sales qualification expert. Score this lead on a 0-100 scale across 5 dimensions.

## Brand / Ideal Customer Profile
${JSON.stringify(brand?.intake || {}, null, 2)}

## Contact / Lead
${JSON.stringify(contact, null, 2)}

## Scoring Dimensions
1. **Fit** (weight 30%): How well does this lead match the ideal customer profile?
2. **Intent** (weight 25%): Are there buying signals or engagement indicators?
3. **Budget** (weight 20%): Can this company likely afford the service?
4. **Timing** (weight 15%): Is there urgency or a good time to reach out?
5. **Accessibility** (weight 10%): Can we reach a decision maker?

Respond with JSON:
{
  "fit": <0-100>,
  "intent": <0-100>,
  "budget": <0-100>,
  "timing": <0-100>,
  "accessibility": <0-100>,
  "total": <weighted average>,
  "summary": "<2 sentence summary>",
  "recommendedAction": "immediate outreach" | "nurture sequence" | "enrich and re-evaluate" | "monitor",
  "talkingPoints": ["<point 1>", "<point 2>", "<point 3>"],
  "estimatedValue": <dollar amount>
}`;

    return ai.generateJSON(prompt);
  }

  estimateDealValue(contact, brand) {
    // Simple heuristic — can be overridden by AI
    const basePrice = brand?.intake?.averageDealSize || 3000;
    if (contact.companySize === 'enterprise' || contact.employees > 200) return basePrice * 3;
    if (contact.companySize === 'mid-market' || contact.employees > 50) return basePrice * 2;
    return basePrice;
  }
}
