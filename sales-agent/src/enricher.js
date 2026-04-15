import { getAIClient } from './ai.js';
import config from './config.js';

/**
 * Contact data enrichment engine.
 * Takes basic contact info and enriches with company data,
 * social profiles, tech stack, and more.
 */
export class Enricher {
  /**
   * Enrich a contact with additional data from multiple sources.
   * @param {object} contact - Basic contact record
   * @returns {{ data: object, fieldsAdded: number, sources: string[] }}
   */
  async enrich(contact) {
    const enriched = {};
    const sources = [];
    let fieldsAdded = 0;

    // Source 1: Company website scraping
    if (contact.website) {
      const websiteData = await this.enrichFromWebsite(contact.website);
      if (websiteData) {
        Object.assign(enriched, websiteData);
        fieldsAdded += Object.keys(websiteData).length;
        sources.push('website');
      }
    }

    // Source 2: Social media profiles
    const socialData = await this.enrichSocialProfiles(contact);
    if (socialData) {
      Object.assign(enriched, socialData);
      fieldsAdded += Object.keys(socialData).length;
      sources.push('social');
    }

    // Source 3: Clearbit API (if configured)
    if (config.enrichment.clearbitApiKey && contact.email) {
      const clearbitData = await this.enrichFromClearbit(contact.email);
      if (clearbitData) {
        Object.assign(enriched, clearbitData);
        fieldsAdded += Object.keys(clearbitData).length;
        sources.push('clearbit');
      }
    }

    // Source 4: ZoomInfo API (if configured)
    if (config.enrichment.zoominfoApiKey && (contact.email || contact.company)) {
      const zoominfoData = await this.enrichFromZoomInfo(contact);
      if (zoominfoData) {
        Object.assign(enriched, zoominfoData);
        fieldsAdded += Object.keys(zoominfoData).length;
        sources.push('zoominfo');
      }
    }

    // Source 5: AI-powered inference from available data
    if (Object.keys(enriched).length > 0 || contact.company) {
      const aiData = await this.aiInference(contact, enriched);
      if (aiData) {
        // Only add AI-inferred fields that aren't already populated
        for (const [key, value] of Object.entries(aiData)) {
          if (!enriched[key] && value) {
            enriched[key] = value;
            fieldsAdded++;
          }
        }
        sources.push('ai-inference');
      }
    }

    return { data: enriched, fieldsAdded, sources };
  }

  /**
   * Scrape company website for enrichment data.
   */
  async enrichFromWebsite(websiteUrl) {
    try {
      const res = await fetch(websiteUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BrandGenBot/1.0)' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;

      const html = await res.text();
      const data = {};

      // Extract description from meta tags
      const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
      if (descMatch) data.companyDescription = descMatch[1];

      // Extract social profiles
      const linkedInMatch = html.match(/href="(https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[^"]+)"/i);
      if (linkedInMatch) data.linkedIn = linkedInMatch[1];

      const facebookMatch = html.match(/href="(https?:\/\/(?:www\.)?facebook\.com\/[^"]+)"/i);
      if (facebookMatch) data.facebook = facebookMatch[1];

      const instagramMatch = html.match(/href="(https?:\/\/(?:www\.)?instagram\.com\/[^"]+)"/i);
      if (instagramMatch) data.instagram = instagramMatch[1];

      const twitterMatch = html.match(/href="(https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^"]+)"/i);
      if (twitterMatch) data.twitter = twitterMatch[1];

      // Extract additional emails from the page
      const emailMatches = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
      if (emailMatches) {
        // Filter out common non-person emails
        const filtered = emailMatches.filter(
          (e) => !/^(noreply|no-reply|unsubscribe|privacy|support@)/.test(e),
        );
        if (filtered.length > 0) data.additionalEmails = [...new Set(filtered)];
      }

      // Extract phone numbers
      const phoneMatches = html.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g);
      if (phoneMatches) data.phone = phoneMatches[0];

      // Try to detect tech stack from script tags and meta
      const techStack = this.detectTechStack(html);
      if (techStack.length > 0) data.techStack = techStack;

      return Object.keys(data).length > 0 ? data : null;
    } catch {
      return null;
    }
  }

  /**
   * Detect technologies used on a website from HTML source.
   */
  detectTechStack(html) {
    const techs = [];
    const checks = [
      { pattern: /wordpress|wp-content/i, name: 'WordPress' },
      { pattern: /shopify/i, name: 'Shopify' },
      { pattern: /squarespace/i, name: 'Squarespace' },
      { pattern: /wix\.com/i, name: 'Wix' },
      { pattern: /webflow/i, name: 'Webflow' },
      { pattern: /hubspot/i, name: 'HubSpot' },
      { pattern: /salesforce/i, name: 'Salesforce' },
      { pattern: /google-analytics|gtag|GA4/i, name: 'Google Analytics' },
      { pattern: /facebook.*pixel|fbq\(/i, name: 'Facebook Pixel' },
      { pattern: /mailchimp/i, name: 'Mailchimp' },
      { pattern: /intercom/i, name: 'Intercom' },
      { pattern: /zendesk/i, name: 'Zendesk' },
      { pattern: /drift\.com/i, name: 'Drift' },
      { pattern: /calendly/i, name: 'Calendly' },
      { pattern: /hotjar/i, name: 'Hotjar' },
      { pattern: /react/i, name: 'React' },
      { pattern: /next\.js|__next/i, name: 'Next.js' },
      { pattern: /stripe/i, name: 'Stripe' },
    ];

    for (const check of checks) {
      if (check.pattern.test(html)) techs.push(check.name);
    }

    return techs;
  }

  /**
   * Build social media profile URLs from known data.
   */
  async enrichSocialProfiles(contact) {
    const data = {};
    const company = contact.company?.replace(/\s+/g, '').toLowerCase();

    if (company && !contact.linkedIn) {
      // Construct likely LinkedIn URL
      data.linkedInGuess = `https://www.linkedin.com/company/${company}`;
    }

    if (company && !contact.facebook) {
      data.facebookGuess = `https://www.facebook.com/${company}`;
    }

    return Object.keys(data).length > 0 ? data : null;
  }

  /**
   * Enrich from Clearbit API.
   */
  async enrichFromClearbit(email) {
    try {
      const res = await fetch(
        `https://person-stream.clearbit.com/v2/combined/find?email=${encodeURIComponent(email)}`,
        {
          headers: { Authorization: `Bearer ${config.enrichment.clearbitApiKey}` },
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!res.ok) return null;

      const result = await res.json();
      const data = {};

      if (result.person) {
        if (result.person.name?.fullName) data.contactName = result.person.name.fullName;
        if (result.person.title) data.title = result.person.title;
        if (result.person.linkedin?.handle) {
          data.linkedIn = `https://www.linkedin.com/in/${result.person.linkedin.handle}`;
        }
      }

      if (result.company) {
        if (result.company.name) data.companyName = result.company.name;
        if (result.company.metrics?.employees) data.employees = result.company.metrics.employees;
        if (result.company.metrics?.estimatedAnnualRevenue) {
          data.estimatedRevenue = result.company.metrics.estimatedAnnualRevenue;
        }
        if (result.company.category?.industry) data.industry = result.company.category.industry;
        if (result.company.description) data.companyDescription = result.company.description;
        if (result.company.tech) data.techStack = result.company.tech;
      }

      return Object.keys(data).length > 0 ? data : null;
    } catch {
      return null;
    }
  }

  /**
   * Enrich from ZoomInfo API.
   */
  async enrichFromZoomInfo(contact) {
    try {
      const query = contact.email || contact.company;
      const res = await fetch(
        `https://api.zoominfo.com/lookup?query=${encodeURIComponent(query)}`,
        {
          headers: {
            Authorization: `Bearer ${config.enrichment.zoominfoApiKey}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!res.ok) return null;

      const result = await res.json();
      const data = {};

      if (result.data) {
        if (result.data.companyName) data.companyName = result.data.companyName;
        if (result.data.employees) data.employees = result.data.employees;
        if (result.data.revenue) data.estimatedRevenue = result.data.revenue;
        if (result.data.industry) data.industry = result.data.industry;
        if (result.data.decisionMakers) data.decisionMakers = result.data.decisionMakers;
      }

      return Object.keys(data).length > 0 ? data : null;
    } catch {
      return null;
    }
  }

  /**
   * Use AI to infer additional data points from what we already know.
   */
  async aiInference(contact, existingEnrichment) {
    try {
      const ai = getAIClient();
      const merged = { ...contact, ...existingEnrichment };

      const prompt = `Given this business contact data, infer any additional useful information.

Contact data:
${JSON.stringify(merged, null, 2)}

Infer and return JSON with ONLY fields you're reasonably confident about:
{
  "companySize": "small" | "mid-market" | "enterprise",
  "estimatedEmployees": <number or null>,
  "estimatedRevenue": <number or null>,
  "industry": "<industry or null>",
  "painPoints": ["<potential pain point>"],
  "bestTimeToReach": "<suggestion>",
  "competitorLikely": "<competitor they might use>"
}

Only include fields where you have reasonable confidence. Omit uncertain fields.`;

      return ai.generateJSON(prompt);
    } catch {
      return null;
    }
  }
}
