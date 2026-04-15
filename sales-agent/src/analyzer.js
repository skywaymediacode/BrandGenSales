import { getAIClient } from './ai.js';

/**
 * Pipeline analysis engine.
 * Analyzes CRM data to surface insights, forecasts, and recommendations.
 */
export class Analyzer {
  /**
   * Analyze the full pipeline and return actionable insights.
   * @param {object} crm - CRM context { contacts, deals, contactStats, dealStats }
   * @returns {Array} Array of insight objects
   */
  async analyzePipeline(crm) {
    const insights = [];

    if (!crm) return insights;

    const deals = crm.deals || [];
    const contacts = crm.contacts || [];

    // 1. Deals likely to close
    const hotDeals = this.findHotDeals(deals);
    if (hotDeals.length > 0) {
      insights.push({
        insightType: 'deals_likely_to_close',
        description: `${hotDeals.length} deal(s) showing strong close signals: ${hotDeals.map((d) => d.title).join(', ')}.`,
        data: hotDeals,
        recommendedAction: 'Prioritize follow-up on these deals.',
        reasoning: 'Deals in late stages with recent activity are most likely to close.',
        priority: 'high',
      });
    }

    // 2. Deals at risk (stalled)
    const stalledDeals = this.findStalledDeals(deals);
    if (stalledDeals.length > 0) {
      insights.push({
        insightType: 'deals_at_risk',
        description: `${stalledDeals.length} deal(s) have stalled with no activity in 7+ days: ${stalledDeals.map((d) => d.title).join(', ')}.`,
        data: stalledDeals,
        recommendedAction: 'Re-engage these contacts or reassess deal viability.',
        reasoning: 'Deals without recent activity often go cold.',
        priority: 'high',
      });
    }

    // 3. Revenue forecast
    const forecast = this.forecastRevenue(deals);
    insights.push({
      insightType: 'revenue_forecast',
      description: `Pipeline forecast — 30 days: $${forecast.d30.toLocaleString()}, 60 days: $${forecast.d60.toLocaleString()}, 90 days: $${forecast.d90.toLocaleString()}.`,
      data: forecast,
      recommendedAction: forecast.d30 > 0 ? 'Focus on closing near-term deals.' : 'Pipeline needs more qualified leads.',
      reasoning: 'Forecast based on deal stage probabilities and values.',
      priority: 'medium',
    });

    // 4. Lead source effectiveness
    const sourceStats = this.analyzeLeadSources(contacts, deals);
    if (sourceStats.length > 0) {
      const best = sourceStats[0];
      insights.push({
        insightType: 'lead_source_effectiveness',
        description: `Best performing lead source: "${best.source}" with ${best.conversionRate}% conversion rate and $${best.totalValue.toLocaleString()} pipeline value.`,
        data: sourceStats,
        recommendedAction: `Double down on "${best.source}" lead generation.`,
        reasoning: 'Allocating resources to top-performing sources maximizes ROI.',
        priority: 'medium',
      });
    }

    // 5. Contacts needing attention
    const neglectedContacts = this.findNeglectedContacts(contacts);
    if (neglectedContacts.length > 0) {
      insights.push({
        insightType: 'neglected_contacts',
        description: `${neglectedContacts.length} contact(s) haven't been reached in 7+ days.`,
        data: neglectedContacts.map((c) => ({
          id: c.id,
          name: `${c.firstName} ${c.lastName}`,
          company: c.company,
          daysSinceContact: c._daysSinceContact,
        })),
        recommendedAction: 'Schedule follow-ups for neglected contacts.',
        reasoning: 'Consistent follow-up prevents leads from going cold.',
        priority: 'medium',
      });
    }

    return insights;
  }

  /**
   * Generate a comprehensive weekly report.
   */
  async generateWeeklyReport(crm) {
    const deals = crm?.deals || [];
    const contacts = crm?.contacts || [];

    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const newDeals = deals.filter((d) => d.createdAt && new Date(d.createdAt).getTime() > oneWeekAgo);
    const closedDeals = deals.filter((d) => d.stage === 'closed-won' && d.closedAt && new Date(d.closedAt).getTime() > oneWeekAgo);
    const lostDeals = deals.filter((d) => d.stage === 'closed-lost' && d.closedAt && new Date(d.closedAt).getTime() > oneWeekAgo);
    const newContacts = contacts.filter((c) => c.createdAt && new Date(c.createdAt).getTime() > oneWeekAgo);

    const totalPipelineValue = deals
      .filter((d) => !['closed-won', 'closed-lost'].includes(d.stage))
      .reduce((sum, d) => sum + (d.value || 0), 0);

    const closedValue = closedDeals.reduce((sum, d) => sum + (d.value || 0), 0);

    const forecast = this.forecastRevenue(deals);

    const report = {
      period: 'weekly',
      generatedAt: new Date().toISOString(),
      summary: '',
      metrics: {
        newContacts: newContacts.length,
        newDeals: newDeals.length,
        dealsWon: closedDeals.length,
        dealsLost: lostDeals.length,
        revenueWon: closedValue,
        totalPipelineValue,
        activeDealCount: deals.filter((d) => !['closed-won', 'closed-lost'].includes(d.stage)).length,
      },
      forecast,
      topOpportunities: this.findHotDeals(deals).slice(0, 5),
      atRisk: this.findStalledDeals(deals).slice(0, 5),
    };

    // Generate AI summary
    try {
      const ai = getAIClient();
      const summaryPrompt = `Write a 3-4 sentence executive summary for this weekly sales report. Be direct and actionable.

${JSON.stringify(report.metrics, null, 2)}

Forecast: 30d=$${forecast.d30}, 60d=$${forecast.d60}, 90d=$${forecast.d90}
Hot deals: ${report.topOpportunities.length}
At-risk deals: ${report.atRisk.length}`;

      report.summary = await ai.generate(summaryPrompt, {
        system: 'You are a concise sales operations analyst. Write plain text, no markdown.',
        maxTokens: 256,
      });
    } catch {
      report.summary = `This week: ${newContacts.length} new contacts, ${newDeals.length} new deals, ${closedDeals.length} won ($${closedValue.toLocaleString()}). Pipeline: $${totalPipelineValue.toLocaleString()} across ${report.metrics.activeDealCount} active deals.`;
    }

    return report;
  }

  // ── Analysis helpers ─────────────────────────────────────────────

  findHotDeals(deals) {
    const closeStages = ['proposal', 'negotiation', 'contract', 'closing'];
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    return deals
      .filter((d) => {
        if (['closed-won', 'closed-lost'].includes(d.stage)) return false;
        const inCloseStage = closeStages.includes(d.stage);
        const recentActivity = d.lastActivityAt && new Date(d.lastActivityAt).getTime() > sevenDaysAgo;
        return inCloseStage || recentActivity;
      })
      .sort((a, b) => (b.value || 0) - (a.value || 0));
  }

  findStalledDeals(deals) {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    return deals.filter((d) => {
      if (['closed-won', 'closed-lost'].includes(d.stage)) return false;
      if (!d.lastActivityAt) return true;
      return new Date(d.lastActivityAt).getTime() < sevenDaysAgo;
    });
  }

  forecastRevenue(deals) {
    // Stage-based probability
    const stageProbability = {
      lead: 0.05,
      qualified: 0.15,
      meeting: 0.3,
      proposal: 0.5,
      negotiation: 0.7,
      contract: 0.85,
      closing: 0.9,
      'closed-won': 1.0,
      'closed-lost': 0,
    };

    const active = deals.filter((d) => !['closed-won', 'closed-lost'].includes(d.stage));

    let d30 = 0;
    let d60 = 0;
    let d90 = 0;

    for (const deal of active) {
      const prob = stageProbability[deal.stage] || 0.1;
      const value = (deal.value || 0) * prob;

      // Assign to time buckets based on stage advancement
      if (prob >= 0.7) d30 += value;
      else if (prob >= 0.3) d60 += value;
      else d90 += value;
    }

    return {
      d30: Math.round(d30),
      d60: Math.round(d30 + d60),
      d90: Math.round(d30 + d60 + d90),
    };
  }

  analyzeLeadSources(contacts, deals) {
    const sourceMap = {};

    for (const contact of contacts) {
      const source = contact.source || 'unknown';
      if (!sourceMap[source]) {
        sourceMap[source] = { source, totalContacts: 0, convertedContacts: 0, totalValue: 0 };
      }
      sourceMap[source].totalContacts++;
    }

    // Match deals to contacts to attribute revenue
    for (const deal of deals) {
      if (deal.stage === 'closed-won' && deal.contactId) {
        const contact = contacts.find((c) => c.id === deal.contactId);
        if (contact) {
          const source = contact.source || 'unknown';
          if (sourceMap[source]) {
            sourceMap[source].convertedContacts++;
            sourceMap[source].totalValue += deal.value || 0;
          }
        }
      }
    }

    return Object.values(sourceMap)
      .map((s) => ({
        ...s,
        conversionRate: s.totalContacts > 0
          ? Math.round((s.convertedContacts / s.totalContacts) * 100)
          : 0,
      }))
      .sort((a, b) => b.conversionRate - a.conversionRate);
  }

  findNeglectedContacts(contacts) {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    return contacts
      .filter((c) => {
        if (!c.lastContactedAt) return true;
        return new Date(c.lastContactedAt).getTime() < sevenDaysAgo;
      })
      .map((c) => ({
        ...c,
        _daysSinceContact: c.lastContactedAt
          ? Math.floor((Date.now() - new Date(c.lastContactedAt).getTime()) / (1000 * 60 * 60 * 24))
          : 999,
      }))
      .sort((a, b) => b._daysSinceContact - a._daysSinceContact);
  }
}
