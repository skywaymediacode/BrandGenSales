import config from './config.js';
import { Scraper } from './scraper.js';
import { Enricher } from './enricher.js';
import { Qualifier } from './qualifier.js';
import { Sequencer } from './sequencer.js';
import { Emailer } from './emailer.js';
import { Analyzer } from './analyzer.js';

/**
 * Main Sales Agent — orchestrates all capabilities and communicates
 * with BrandGen through its REST API.
 */
export class SalesAgent {
  constructor() {
    this.scraper = new Scraper();
    this.enricher = new Enricher();
    this.qualifier = new Qualifier();
    this.sequencer = new Sequencer();
    this.emailer = new Emailer();
    this.analyzer = new Analyzer();
    this.profileId = null;
    this.brandContext = null;
  }

  async initialize(runtimeConfig) {
    if (runtimeConfig?.profileId) {
      this.profileId = runtimeConfig.profileId;
    }
    await this.emailer.initialize();
    await this.sequencer.load();
  }

  // ── BrandGen API helpers ─────────────────────────────────────────

  async fetchContext(profileId) {
    const pid = profileId || this.profileId;
    if (!pid) throw new Error('No profileId set — cannot fetch context');

    const res = await fetch(
      `${config.brandgen.url}/api/agents/${pid}/context?scopes=brand,crm,nurture`,
      { headers: { Authorization: `Bearer ${config.brandgen.token}` } },
    );
    if (!res.ok) throw new Error(`BrandGen context fetch failed: ${res.status}`);
    this.brandContext = await res.json();
    return this.brandContext;
  }

  async proposeAction(action) {
    const pid = action.profileId || this.profileId;
    const res = await fetch(
      `${config.brandgen.url}/api/agents/${pid}/actions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.brandgen.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agentKey: 'sales_agent',
          ...action,
        }),
      },
    );
    if (!res.ok) throw new Error(`Action proposal failed: ${res.status}`);
    return res.json();
  }

  // ── Event handling ───────────────────────────────────────────────

  async handleEvent(event, context) {
    const handlers = {
      new_contact: (e, ctx) => this.onNewContact(e, ctx),
      deal_stage_change: (e, ctx) => this.onDealStageChange(e, ctx),
      contact_inactive: (e, ctx) => this.onContactInactive(e, ctx),
      daily_digest: (e, ctx) => this.onDailyDigest(e, ctx),
      weekly_report: (e, ctx) => this.onWeeklyReport(e, ctx),
    };

    const handler = handlers[event.type];
    if (!handler) return [];

    this.brandContext = context;
    return handler(event, context);
  }

  async onNewContact(event, context) {
    const contact = event.payload;
    const actions = [];

    // Enrich the new contact
    const enriched = await this.enricher.enrich(contact);
    if (enriched.fieldsAdded > 0) {
      actions.push({
        type: 'update_contact',
        payload: { id: contact.id, ...enriched.data },
        reasoning: `Enriched contact with ${enriched.fieldsAdded} additional fields from ${enriched.sources.join(', ')}.`,
        priority: 'medium',
        requiresApproval: true,
      });
    }

    // Qualify the contact
    const score = await this.qualifier.qualify(contact, context.brand);
    actions.push({
      type: 'log_note',
      payload: {
        contactId: contact.id,
        note: `Qualification score: ${score.total}/100 — ${score.summary}`,
      },
      reasoning: score.summary,
      priority: score.total >= config.agent.autoQualifyThreshold * 100 ? 'high' : 'low',
      requiresApproval: false,
    });

    // If qualified, create a deal and start outreach sequence
    if (score.total >= config.agent.autoQualifyThreshold * 100) {
      actions.push({
        type: 'create_deal',
        payload: {
          title: `${contact.company || contact.firstName + ' ' + contact.lastName} — New Opportunity`,
          contactId: contact.id,
          value: score.estimatedValue || 0,
          stage: 'qualified',
        },
        reasoning: `Lead scored ${score.total}/100, above threshold of ${config.agent.autoQualifyThreshold * 100}. Creating deal.`,
        priority: 'high',
        requiresApproval: true,
      });

      if (config.agent.mode !== 'assist') {
        const emailAction = await this.startOutreachSequence(contact, context);
        if (emailAction) actions.push(emailAction);
      }
    }

    return actions;
  }

  async onDealStageChange(event, context) {
    const { dealId, previousStage, newStage, contact } = event.payload;
    const actions = [];

    // Switch sequence based on new stage
    if (newStage === 'proposal') {
      const sequence = this.sequencer.getSequence('closing');
      if (sequence && contact) {
        const nextStep = this.sequencer.getNextStep(contact.id, 'closing');
        if (nextStep) {
          const email = await this.emailer.compose(nextStep, contact, context.brand);
          actions.push({
            type: 'send_email',
            payload: { to: contact.email, ...email },
            reasoning: `Deal moved to proposal stage. Starting closing sequence.`,
            priority: 'high',
            requiresApproval: true,
          });
        }
      }
    }

    actions.push({
      type: 'log_note',
      payload: {
        dealId,
        note: `Deal stage changed from "${previousStage}" to "${newStage}".`,
      },
      reasoning: 'Stage change logged for audit trail.',
      priority: 'low',
      requiresApproval: false,
    });

    return actions;
  }

  async onContactInactive(event, context) {
    const { contact, daysSinceLastActivity } = event.payload;
    const actions = [];

    if (daysSinceLastActivity >= 14) {
      const sequence = this.sequencer.getSequence('re-engagement');
      if (sequence) {
        const nextStep = this.sequencer.getNextStep(contact.id, 're-engagement');
        if (nextStep) {
          const email = await this.emailer.compose(nextStep, contact, context.brand);
          actions.push({
            type: 'send_email',
            payload: { to: contact.email, ...email },
            reasoning: `Contact inactive for ${daysSinceLastActivity} days. Starting re-engagement sequence.`,
            priority: 'medium',
            requiresApproval: true,
          });
        }
      }
    }

    actions.push({
      type: 'surface_insight',
      payload: {
        insightType: 'contact_inactive',
        description: `${contact.firstName} ${contact.lastName} (${contact.company}) has been inactive for ${daysSinceLastActivity} days.`,
        recommendedAction: daysSinceLastActivity >= 14 ? 're-engagement sequence' : 'manual check-in',
      },
      reasoning: `Inactive contact detected — surfacing for review.`,
      priority: 'medium',
      requiresApproval: false,
    });

    return actions;
  }

  async onDailyDigest(_event, context) {
    const actions = [];

    // Check for due sequence steps
    const dueSteps = this.sequencer.getDueSteps();
    for (const step of dueSteps) {
      const contact = context.crm?.contacts?.find((c) => c.id === step.contactId);
      if (!contact) continue;

      const email = await this.emailer.compose(step, contact, context.brand);
      actions.push({
        type: 'send_email',
        payload: { to: contact.email, ...email },
        reasoning: `Scheduled follow-up (${step.sequenceKey}, step ${step.stepIndex + 1}).`,
        priority: 'medium',
        requiresApproval: config.agent.mode === 'assist',
      });
    }

    // Pipeline analysis
    const insights = await this.analyzer.analyzePipeline(context.crm);
    for (const insight of insights) {
      actions.push({
        type: 'surface_insight',
        payload: insight,
        reasoning: insight.reasoning,
        priority: insight.priority || 'medium',
        requiresApproval: false,
      });
    }

    return actions;
  }

  async onWeeklyReport(_event, context) {
    const report = await this.analyzer.generateWeeklyReport(context.crm);
    return [
      {
        type: 'surface_insight',
        payload: {
          insightType: 'weekly_report',
          description: report.summary,
          data: report,
        },
        reasoning: 'Weekly pipeline report generated.',
        priority: 'medium',
        requiresApproval: false,
      },
    ];
  }

  // ── Goal-driven proposals ────────────────────────────────────────

  async handleGoal(goal, context) {
    this.brandContext = context;

    // Parse the natural-language goal with AI to determine intent
    const intent = await this.parseGoalIntent(goal);

    switch (intent.action) {
      case 'find_leads':
        return this.findLeads(intent.params, context);
      case 'follow_up':
        return this.followUpBatch(intent.params, context);
      case 'qualify':
        return this.qualifyBatch(intent.params, context);
      case 'analyze':
        return this.analyzePipeline(context);
      case 'send_email':
        return this.composeSingleEmail(intent.params, context);
      default:
        return [{
          type: 'log_note',
          payload: { note: `Could not parse goal: "${goal}"` },
          reasoning: 'Goal intent not recognized.',
          priority: 'low',
          requiresApproval: false,
        }];
    }
  }

  async parseGoalIntent(goal) {
    const { getAIClient } = await import('./ai.js');
    const ai = getAIClient();
    const prompt = `You are a sales operations assistant. Parse this natural language goal into a structured intent.

Goal: "${goal}"

Respond with JSON only:
{
  "action": "find_leads" | "follow_up" | "qualify" | "analyze" | "send_email",
  "params": {
    // For find_leads: { industry, location, count }
    // For follow_up: { filter, daysSinceLastContact }
    // For qualify: { filter }
    // For analyze: {}
    // For send_email: { contactId, templateKey }
  }
}`;

    const result = await ai.generateJSON(prompt);
    return result;
  }

  // ── Capability methods ───────────────────────────────────────────

  async findLeads(params, context) {
    const { industry, location, count = 50 } = params;
    const query = industry && location
      ? `${industry} in ${location}`
      : context.brand?.intake?.targetMarket || 'local businesses';

    const leads = await this.scraper.scrape(query, count);
    const actions = [];

    for (const lead of leads) {
      actions.push({
        type: 'create_contact',
        payload: {
          firstName: lead.contactName?.split(' ')[0] || '',
          lastName: lead.contactName?.split(' ').slice(1).join(' ') || '',
          email: lead.email || '',
          phone: lead.phone || '',
          company: lead.businessName,
          website: lead.website || '',
          address: lead.address || '',
          city: lead.city || '',
          state: lead.state || '',
          source: 'agent-scrape',
          tags: lead.tags || [],
          notes: lead.notes || '',
        },
        reasoning: `Scraped lead matching "${query}". ${lead.notes || ''}`,
        priority: 'medium',
        requiresApproval: true,
      });
    }

    return actions;
  }

  async followUpBatch(params, context) {
    const { daysSinceLastContact = 3 } = params;
    const contacts = (context.crm?.contacts || []).filter((c) => {
      if (!c.lastContactedAt) return true;
      const daysSince = (Date.now() - new Date(c.lastContactedAt).getTime()) / (1000 * 60 * 60 * 24);
      return daysSince >= daysSinceLastContact;
    });

    const actions = [];
    for (const contact of contacts) {
      const step = this.sequencer.getNextStep(contact.id, 'follow-up');
      if (!step) continue;

      const email = await this.emailer.compose(step, contact, context.brand);
      actions.push({
        type: 'send_email',
        payload: { to: contact.email, ...email },
        reasoning: `Contact hasn't been reached in ${daysSinceLastContact}+ days. Sending follow-up.`,
        priority: 'medium',
        requiresApproval: true,
      });
    }

    return actions;
  }

  async qualifyBatch(params, context) {
    const contacts = context.crm?.contacts || [];
    const actions = [];

    for (const contact of contacts) {
      const score = await this.qualifier.qualify(contact, context.brand);
      actions.push({
        type: 'update_contact',
        payload: {
          id: contact.id,
          qualificationScore: score.total,
          qualificationSummary: score.summary,
          qualifiedAt: new Date().toISOString(),
        },
        reasoning: `Qualification: ${score.total}/100 — ${score.summary}`,
        priority: score.total >= config.agent.autoQualifyThreshold * 100 ? 'high' : 'low',
        requiresApproval: true,
      });
    }

    return actions;
  }

  async analyzePipeline(context) {
    const insights = await this.analyzer.analyzePipeline(context.crm);
    return insights.map((insight) => ({
      type: 'surface_insight',
      payload: insight,
      reasoning: insight.reasoning,
      priority: insight.priority || 'medium',
      requiresApproval: false,
    }));
  }

  async composeSingleEmail(params, context) {
    const { contactId, templateKey = 'cold-outreach' } = params;
    const contact = (context.crm?.contacts || []).find((c) => c.id === contactId);
    if (!contact) {
      return [{
        type: 'log_note',
        payload: { note: `Contact ${contactId} not found.` },
        reasoning: 'Could not find contact to email.',
        priority: 'low',
        requiresApproval: false,
      }];
    }

    const step = this.sequencer.getNextStep(contact.id, templateKey) || {
      sequenceKey: templateKey,
      stepIndex: 0,
      template: 'intro',
    };
    const email = await this.emailer.compose(step, contact, context.brand);
    return [{
      type: 'send_email',
      payload: { to: contact.email, ...email },
      reasoning: `Composing ${templateKey} email for ${contact.firstName} ${contact.lastName}.`,
      priority: 'medium',
      requiresApproval: true,
    }];
  }

  // ── Action execution (post-approval) ────────────────────────────

  async executeAction(action, executor) {
    const executors = {
      create_contact: (a, ex) => ex.createContact(a.payload),
      update_contact: (a, ex) => ex.updateContact(a.payload.id, a.payload),
      create_deal: (a, ex) => ex.createDeal(a.payload),
      update_deal: (a, ex) => ex.updateDeal(a.payload.id, a.payload),
      send_email: (a, _ex) => this.emailer.send(a.payload),
      log_note: (a, ex) => ex.logNote(a.payload.note || a.payload),
      surface_insight: (a, ex) => ex.logNote(`[Insight] ${a.payload.description}`),
    };

    const exec = executors[action.type];
    if (!exec) throw new Error(`Unknown action type: ${action.type}`);
    return exec(action, executor);
  }

  // ── Helpers ──────────────────────────────────────────────────────

  async startOutreachSequence(contact, context) {
    const sequence = this.sequencer.getSequence('cold-outreach');
    if (!sequence) return null;

    const step = this.sequencer.startSequence(contact.id, 'cold-outreach');
    if (!step) return null;

    const email = await this.emailer.compose(step, contact, context.brand);
    return {
      type: 'send_email',
      payload: { to: contact.email, ...email },
      reasoning: `Qualified lead — starting cold outreach sequence.`,
      priority: 'high',
      requiresApproval: config.agent.mode === 'assist',
    };
  }
}
