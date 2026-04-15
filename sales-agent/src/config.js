import 'dotenv/config';

const config = {
  brandgen: {
    url: process.env.BRANDGEN_URL || 'http://localhost:3001',
    token: process.env.BRANDGEN_TOKEN || '',
  },

  ai: {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    primaryModel: 'claude-sonnet-4-20250514',
    fallbackModel: 'gpt-4o',
  },

  email: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    fromName: process.env.SMTP_FROM_NAME || '',
    fromEmail: process.env.SMTP_FROM_EMAIL || '',
  },

  enrichment: {
    clearbitApiKey: process.env.CLEARBIT_API_KEY || '',
    zoominfoApiKey: process.env.ZOOMINFO_API_KEY || '',
  },

  scraping: {
    rateLimitMs: parseInt(process.env.SCRAPE_RATE_LIMIT_MS || '3000', 10),
    maxPerSession: parseInt(process.env.SCRAPE_MAX_PER_SESSION || '100', 10),
  },

  // Defaults from manifest — overridden by BrandGen at runtime
  agent: {
    followUpDelayHours: 24,
    maxEmailsPerDay: 50,
    autoQualifyThreshold: 0.7,
    scrapeTargets: [],
    enrichmentSources: ['clearbit', 'zoominfo', 'linkedin'],
    mode: 'assist', // assist | semi_auto | auto
  },
};

/**
 * Merge runtime config from BrandGen into the agent config.
 */
export function applyRuntimeConfig(runtimeConfig) {
  if (!runtimeConfig) return;
  Object.assign(config.agent, runtimeConfig);
}

export default config;
