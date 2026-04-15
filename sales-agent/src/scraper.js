import config from './config.js';

/**
 * Lead scraping engine.
 * Scrapes Google Maps listings, business directories, and websites
 * to find potential leads matching a query.
 */
export class Scraper {
  constructor() {
    this.browser = null;
    this.scrapedCount = 0;
    this.userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ];
  }

  async ensureBrowser() {
    if (this.browser) return this.browser;
    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({ headless: true });
    return this.browser;
  }

  async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Main scraping entry point.
   * @param {string} query - Search query, e.g. "dental practices in South Florida"
   * @param {number} maxResults - Max leads to return
   * @returns {Array} Array of lead objects
   */
  async scrape(query, maxResults = 50) {
    const limit = Math.min(maxResults, config.scraping.maxPerSession);
    const leads = [];

    // Strategy 1: Google Maps business listings
    const mapLeads = await this.scrapeGoogleMaps(query, Math.ceil(limit * 0.6));
    leads.push(...mapLeads);

    // Strategy 2: Google search for business websites
    if (leads.length < limit) {
      const webLeads = await this.scrapeGoogleSearch(query, limit - leads.length);
      leads.push(...webLeads);
    }

    // Deduplicate by business name + city
    const seen = new Set();
    const unique = leads.filter((lead) => {
      const key = `${(lead.businessName || '').toLowerCase()}|${(lead.city || '').toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    await this.closeBrowser();
    return unique.slice(0, limit);
  }

  /**
   * Scrape Google Maps for business listings.
   */
  async scrapeGoogleMaps(query, maxResults) {
    const leads = [];

    try {
      const browser = await this.ensureBrowser();
      const context = await browser.newContext({
        userAgent: this.randomUserAgent(),
      });
      const page = await context.newPage();

      const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
      await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });

      // Wait for results to load
      await page.waitForTimeout(3000);

      // Scroll through results to load more
      const feed = page.locator('[role="feed"]');
      if (await feed.count() > 0) {
        for (let i = 0; i < 5 && leads.length < maxResults; i++) {
          await feed.evaluate((el) => el.scrollBy(0, 1000));
          await this.rateLimit();
        }
      }

      // Extract business listings
      const items = page.locator('[role="feed"] > div > div > a');
      const count = Math.min(await items.count(), maxResults);

      for (let i = 0; i < count; i++) {
        if (this.scrapedCount >= config.scraping.maxPerSession) break;

        try {
          const item = items.nth(i);
          const ariaLabel = await item.getAttribute('aria-label');
          const href = await item.getAttribute('href');

          if (!ariaLabel) continue;

          // Click into the listing for more details
          await item.click();
          await page.waitForTimeout(2000);

          const lead = await this.extractMapListing(page, ariaLabel, href);
          if (lead && lead.businessName) {
            leads.push(lead);
            this.scrapedCount++;
          }

          // Go back to results
          await page.goBack({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
          await this.rateLimit();
        } catch {
          continue;
        }
      }

      await context.close();
    } catch (err) {
      console.error('[Scraper] Google Maps scraping error:', err.message);
    }

    return leads;
  }

  /**
   * Extract details from a Google Maps listing page.
   */
  async extractMapListing(page, ariaLabel, href) {
    const lead = {
      businessName: ariaLabel || '',
      website: '',
      phone: '',
      email: '',
      address: '',
      city: '',
      state: '',
      contactName: '',
      rating: '',
      reviewCount: '',
      tags: [],
      notes: '',
      source: 'google-maps',
    };

    try {
      // Extract phone
      const phoneEl = page.locator('[data-tooltip="Copy phone number"]');
      if (await phoneEl.count() > 0) {
        const phoneText = await phoneEl.first().textContent();
        lead.phone = phoneText?.trim() || '';
      }

      // Extract website
      const websiteEl = page.locator('[data-tooltip="Open website"]');
      if (await websiteEl.count() > 0) {
        const websiteHref = await websiteEl.first().getAttribute('href');
        lead.website = websiteHref || '';
      }

      // Extract address
      const addressEl = page.locator('[data-tooltip="Copy address"]');
      if (await addressEl.count() > 0) {
        const addressText = await addressEl.first().textContent();
        if (addressText) {
          lead.address = addressText.trim();
          const parts = addressText.split(',').map((s) => s.trim());
          if (parts.length >= 2) {
            lead.city = parts[parts.length - 2] || '';
            const stateZip = parts[parts.length - 1] || '';
            lead.state = stateZip.split(/\s+/)[0] || '';
          }
        }
      }

      // Extract rating
      const ratingEl = page.locator('[role="img"][aria-label*="stars"]');
      if (await ratingEl.count() > 0) {
        const ratingLabel = await ratingEl.first().getAttribute('aria-label');
        if (ratingLabel) {
          const match = ratingLabel.match(/([\d.]+)\s*stars?/i);
          lead.rating = match ? match[1] : '';
        }
      }

      // Extract review count
      const reviewEl = page.locator('button[aria-label*="reviews"]');
      if (await reviewEl.count() > 0) {
        const reviewLabel = await reviewEl.first().getAttribute('aria-label');
        if (reviewLabel) {
          const match = reviewLabel.match(/([\d,]+)\s*reviews?/i);
          lead.reviewCount = match ? match[1].replace(',', '') : '';
        }
      }

      // Extract category
      const categoryEl = page.locator('button[jsaction*="category"]');
      if (await categoryEl.count() > 0) {
        const categoryText = await categoryEl.first().textContent();
        if (categoryText) lead.tags.push(categoryText.trim());
      }

      // Build notes
      const noteParts = [];
      if (lead.rating) noteParts.push(`${lead.rating} star rating`);
      if (lead.reviewCount) noteParts.push(`${lead.reviewCount} reviews`);
      lead.notes = noteParts.join(', ') + (noteParts.length ? '.' : '');

      // Try to get email from website
      if (lead.website) {
        const emailData = await this.scrapeEmailFromWebsite(lead.website);
        if (emailData.email) lead.email = emailData.email;
        if (emailData.contactName) lead.contactName = emailData.contactName;
      }
    } catch {
      // Partial data is fine
    }

    return lead;
  }

  /**
   * Scrape Google search results for business websites.
   */
  async scrapeGoogleSearch(query, maxResults) {
    const leads = [];

    try {
      const browser = await this.ensureBrowser();
      const context = await browser.newContext({
        userAgent: this.randomUserAgent(),
      });
      const page = await context.newPage();

      const searchQuery = `${query} contact email`;
      await page.goto(
        `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`,
        { waitUntil: 'networkidle', timeout: 30000 },
      );

      // Extract search result links
      const results = page.locator('#search a[href^="http"]:not([href*="google"])');
      const count = Math.min(await results.count(), maxResults * 2);

      for (let i = 0; i < count && leads.length < maxResults; i++) {
        if (this.scrapedCount >= config.scraping.maxPerSession) break;

        try {
          const href = await results.nth(i).getAttribute('href');
          if (!href || href.includes('google.com') || href.includes('youtube.com')) continue;

          const emailData = await this.scrapeEmailFromWebsite(href);
          if (emailData.businessName || emailData.email) {
            leads.push({
              businessName: emailData.businessName || new URL(href).hostname.replace('www.', ''),
              website: href,
              email: emailData.email || '',
              phone: emailData.phone || '',
              contactName: emailData.contactName || '',
              address: '',
              city: '',
              state: '',
              tags: [],
              notes: 'Found via Google search.',
              source: 'google-search',
            });
            this.scrapedCount++;
          }

          await this.rateLimit();
        } catch {
          continue;
        }
      }

      await context.close();
    } catch (err) {
      console.error('[Scraper] Google search scraping error:', err.message);
    }

    return leads;
  }

  /**
   * Visit a website and extract contact information.
   */
  async scrapeEmailFromWebsite(url) {
    const data = { email: '', phone: '', contactName: '', businessName: '' };

    try {
      const browser = await this.ensureBrowser();
      const context = await browser.newContext({
        userAgent: this.randomUserAgent(),
      });
      const page = await context.newPage();

      // Check robots.txt first
      const allowed = await this.checkRobotsTxt(url);
      if (!allowed) {
        await context.close();
        return data;
      }

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const bodyText = await page.textContent('body').catch(() => '') || '';
      const title = await page.title().catch(() => '') || '';

      // Extract email addresses
      const emailMatches = bodyText.match(
        /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      );
      if (emailMatches) {
        // Prefer info@, contact@, hello@ emails
        const preferred = emailMatches.find((e) =>
          /^(info|contact|hello|sales|team)@/i.test(e),
        );
        data.email = preferred || emailMatches[0];
      }

      // Extract phone numbers
      const phoneMatches = bodyText.match(
        /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
      );
      if (phoneMatches) {
        data.phone = phoneMatches[0];
      }

      // Business name from title
      data.businessName = title.split(/[|–—-]/)[0]?.trim() || '';

      // Try to find contact/about page for contact name
      const aboutLink = page.locator('a[href*="about"], a[href*="team"], a[href*="contact"]').first();
      if (await aboutLink.count() > 0) {
        try {
          await aboutLink.click();
          await page.waitForTimeout(2000);
          const aboutText = await page.textContent('body').catch(() => '') || '';

          // Look for common name patterns near titles like "Owner", "Founder", "CEO"
          const nameMatch = aboutText.match(
            /(?:owner|founder|ceo|director|manager|president)[:\s]*([A-Z][a-z]+ [A-Z][a-z]+)/i,
          );
          if (nameMatch) data.contactName = nameMatch[1];

          // Pick up email from about page too
          if (!data.email) {
            const aboutEmails = aboutText.match(
              /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
            );
            if (aboutEmails) data.email = aboutEmails[0];
          }
        } catch {
          // About page navigation failed — that's fine
        }
      }

      await context.close();
    } catch {
      // Website scrape failed — return partial data
    }

    return data;
  }

  /**
   * Basic robots.txt check. Returns true if scraping is allowed.
   */
  async checkRobotsTxt(url) {
    try {
      const origin = new URL(url).origin;
      const res = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return true; // No robots.txt = allowed

      const text = await res.text();
      // Basic check: if Disallow: / for all agents, don't scrape
      if (/User-agent:\s*\*[\s\S]*?Disallow:\s*\/\s*$/m.test(text)) {
        return false;
      }
      return true;
    } catch {
      return true; // Can't fetch robots.txt = assume allowed
    }
  }

  randomUserAgent() {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  async rateLimit() {
    const delay = config.scraping.rateLimitMs + Math.floor(Math.random() * 1000);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
