import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', 'templates');
const STATE_FILE = join(__dirname, '..', '.sequence-state.json');

/**
 * Follow-up sequence engine.
 * Manages multi-step outreach sequences with configurable timing.
 * State persists across restarts via a JSON state file.
 */
export class Sequencer {
  constructor() {
    this.sequences = {};    // sequence templates keyed by name
    this.state = {};        // active sequences keyed by contactId
  }

  /**
   * Load sequence templates and restore persisted state.
   */
  async load() {
    this.loadTemplates();
    this.loadState();
  }

  loadTemplates() {
    const templateFiles = [
      'cold-outreach.json',
      'follow-up.json',
      're-engagement.json',
      'closing.json',
    ];

    for (const file of templateFiles) {
      const path = join(TEMPLATES_DIR, file);
      try {
        const data = JSON.parse(readFileSync(path, 'utf-8'));
        this.sequences[data.key] = data;
      } catch {
        console.warn(`[Sequencer] Could not load template: ${file}`);
      }
    }
  }

  loadState() {
    try {
      if (existsSync(STATE_FILE)) {
        this.state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      }
    } catch {
      this.state = {};
    }
  }

  saveState() {
    try {
      const dir = dirname(STATE_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error('[Sequencer] Failed to save state:', err.message);
    }
  }

  /**
   * Get a sequence template by key.
   */
  getSequence(key) {
    return this.sequences[key] || null;
  }

  /**
   * Start a sequence for a contact. Returns the first step.
   */
  startSequence(contactId, sequenceKey) {
    const sequence = this.sequences[sequenceKey];
    if (!sequence || !sequence.steps?.length) return null;

    const stateKey = `${contactId}:${sequenceKey}`;

    this.state[stateKey] = {
      contactId,
      sequenceKey,
      currentStep: 0,
      startedAt: new Date().toISOString(),
      lastStepAt: new Date().toISOString(),
      status: 'active',
    };
    this.saveState();

    return {
      contactId,
      sequenceKey,
      stepIndex: 0,
      ...sequence.steps[0],
    };
  }

  /**
   * Get the next step in a sequence for a contact.
   * Returns null if the sequence is complete or not started.
   */
  getNextStep(contactId, sequenceKey) {
    const sequence = this.sequences[sequenceKey];
    if (!sequence || !sequence.steps?.length) return null;

    const stateKey = `${contactId}:${sequenceKey}`;
    const entry = this.state[stateKey];

    if (!entry || entry.status !== 'active') {
      // Not started yet — start it
      return this.startSequence(contactId, sequenceKey);
    }

    const nextIndex = entry.currentStep + 1;
    if (nextIndex >= sequence.steps.length) {
      // Sequence complete
      entry.status = 'completed';
      this.saveState();
      return null;
    }

    return {
      contactId,
      sequenceKey,
      stepIndex: nextIndex,
      ...sequence.steps[nextIndex],
    };
  }

  /**
   * Mark the current step as sent and advance the sequence.
   */
  advanceStep(contactId, sequenceKey) {
    const stateKey = `${contactId}:${sequenceKey}`;
    const entry = this.state[stateKey];
    if (!entry || entry.status !== 'active') return;

    const sequence = this.sequences[sequenceKey];
    entry.currentStep++;
    entry.lastStepAt = new Date().toISOString();

    if (entry.currentStep >= (sequence?.steps?.length || 0)) {
      entry.status = 'completed';
    }

    this.saveState();
  }

  /**
   * Pause a sequence (e.g., contact responded).
   */
  pauseSequence(contactId, sequenceKey) {
    const stateKey = `${contactId}:${sequenceKey}`;
    const entry = this.state[stateKey];
    if (entry) {
      entry.status = 'paused';
      this.saveState();
    }
  }

  /**
   * Stop a sequence entirely.
   */
  stopSequence(contactId, sequenceKey) {
    const stateKey = `${contactId}:${sequenceKey}`;
    const entry = this.state[stateKey];
    if (entry) {
      entry.status = 'stopped';
      this.saveState();
    }
  }

  /**
   * Get all sequence steps that are due to be sent now.
   * A step is "due" if enough time has passed since the last step.
   */
  getDueSteps() {
    const now = Date.now();
    const dueSteps = [];

    for (const [_stateKey, entry] of Object.entries(this.state)) {
      if (entry.status !== 'active') continue;

      const sequence = this.sequences[entry.sequenceKey];
      if (!sequence) continue;

      const nextIndex = entry.currentStep + 1;
      if (nextIndex >= sequence.steps.length) continue;

      const step = sequence.steps[nextIndex];
      const delayMs = (step.delayDays || 0) * 24 * 60 * 60 * 1000;
      const lastStepTime = new Date(entry.lastStepAt).getTime();

      if (now >= lastStepTime + delayMs) {
        dueSteps.push({
          contactId: entry.contactId,
          sequenceKey: entry.sequenceKey,
          stepIndex: nextIndex,
          ...step,
        });
      }
    }

    return dueSteps;
  }

  /**
   * Get the status of all active sequences for a contact.
   */
  getContactSequences(contactId) {
    const result = [];
    for (const [_key, entry] of Object.entries(this.state)) {
      if (entry.contactId === contactId) {
        result.push({ ...entry });
      }
    }
    return result;
  }

  /**
   * Get summary stats across all sequences.
   */
  getStats() {
    const entries = Object.values(this.state);
    return {
      total: entries.length,
      active: entries.filter((e) => e.status === 'active').length,
      completed: entries.filter((e) => e.status === 'completed').length,
      paused: entries.filter((e) => e.status === 'paused').length,
      stopped: entries.filter((e) => e.status === 'stopped').length,
    };
  }
}
