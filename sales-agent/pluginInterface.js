/**
 * BrandGen AgentPlugin base class.
 * All agent plugins extend this to integrate with the BrandGen platform.
 */
export class AgentPlugin {
  constructor(manifest) {
    this.manifest = manifest;
  }

  async initialize(config) {
    throw new Error('Must implement initialize()');
  }

  async onEvent(event, context) {
    throw new Error('Must implement onEvent()');
  }

  async propose(goal, context) {
    throw new Error('Must implement propose()');
  }

  async execute(action, executor) {
    throw new Error('Must implement execute()');
  }

  async healthCheck() {
    return {
      status: 'ok',
      agent: this.manifest.key,
      version: this.manifest.version,
    };
  }

  async shutdown() {}
}
