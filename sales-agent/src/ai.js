import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import config from './config.js';

let aiClient = null;

class AIClient {
  constructor() {
    this.anthropic = config.ai.anthropicApiKey
      ? new Anthropic({ apiKey: config.ai.anthropicApiKey })
      : null;

    this.openai = config.ai.openaiApiKey
      ? new OpenAI({ apiKey: config.ai.openaiApiKey })
      : null;
  }

  async generate(prompt, { system, maxTokens = 2048 } = {}) {
    if (this.anthropic) {
      return this._generateAnthropic(prompt, { system, maxTokens });
    }
    if (this.openai) {
      return this._generateOpenAI(prompt, { system, maxTokens });
    }
    throw new Error('No AI provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
  }

  async generateJSON(prompt, { system, maxTokens = 2048 } = {}) {
    const systemMsg = (system || '') + '\nRespond with valid JSON only. No markdown, no explanation.';
    const raw = await this.generate(prompt, { system: systemMsg.trim(), maxTokens });
    // Strip markdown fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return JSON.parse(cleaned);
  }

  async _generateAnthropic(prompt, { system, maxTokens }) {
    const messages = [{ role: 'user', content: prompt }];
    const params = {
      model: config.ai.primaryModel,
      max_tokens: maxTokens,
      messages,
    };
    if (system) params.system = system;

    const response = await this.anthropic.messages.create(params);
    return response.content[0]?.text || '';
  }

  async _generateOpenAI(prompt, { system, maxTokens }) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });

    const response = await this.openai.chat.completions.create({
      model: config.ai.fallbackModel,
      max_tokens: maxTokens,
      messages,
    });
    return response.choices[0]?.message?.content || '';
  }
}

export function getAIClient() {
  if (!aiClient) aiClient = new AIClient();
  return aiClient;
}
