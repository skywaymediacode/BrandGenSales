import { AgentPlugin } from './pluginInterface.js';
import { SalesAgent } from './src/agent.js';
import { applyRuntimeConfig } from './src/config.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, 'manifest.json'), 'utf-8'));

class SalesAgentPlugin extends AgentPlugin {
  constructor() {
    super(manifest);
    this.agent = new SalesAgent();
  }

  async initialize(config) {
    applyRuntimeConfig(config);
    await this.agent.initialize(config);
  }

  async onEvent(event, context) {
    return this.agent.handleEvent(event, context);
  }

  async propose(goal, context) {
    return this.agent.handleGoal(goal, context);
  }

  async execute(action, executor) {
    return this.agent.executeAction(action, executor);
  }

  async healthCheck() {
    const base = await super.healthCheck();
    return {
      ...base,
      capabilities: ['scrape', 'enrich', 'qualify', 'sequence', 'email', 'analyze'],
    };
  }

  async shutdown() {
    // Clean up resources
  }
}

export default new SalesAgentPlugin();
