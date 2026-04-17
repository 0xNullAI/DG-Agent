import type { WaveformLibraryPort } from '@dg-agent/contracts';
import type { ToolCall, ToolDefinition, ToolExecutionPlan } from '@dg-agent/core';
import { z } from 'zod';

export interface ToolHandler {
  definition: ToolDefinition;
  toExecutionPlan(args: Record<string, unknown>): Promise<ToolExecutionPlan> | ToolExecutionPlan;
}

export class ToolRegistry {
  private readonly handlers = new Map<string, ToolHandler>();

  register(handler: ToolHandler): void {
    this.handlers.set(handler.definition.name, handler);
  }

  async resolve(toolCall: ToolCall): Promise<ToolExecutionPlan> {
    const handler = this.handlers.get(toolCall.name);
    if (!handler) {
      throw new Error(`Unknown tool: ${toolCall.name}`);
    }

    return handler.toExecutionPlan(toolCall.args);
  }

  listDefinitions(): ToolDefinition[] {
    return [...this.handlers.values()].map((handler) => handler.definition);
  }
}

const channelSchema = z.enum(['A', 'B']);

export function createDefaultToolRegistry(): ToolRegistry {
  return createDefaultToolRegistryWithDeps({});
}

export interface DefaultToolRegistryDeps {
  waveformLibrary?: WaveformLibraryPort;
}

export function createDefaultToolRegistryWithDeps(deps: DefaultToolRegistryDeps): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    definition: {
      name: 'start',
      description: 'Start one channel with a waveform and initial strength.',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', enum: ['A', 'B'] },
          strength: { type: 'integer', minimum: 0, maximum: 200 },
          waveformId: { type: 'string' },
          loop: { type: 'boolean' },
        },
        required: ['channel', 'strength', 'waveformId'],
      },
    },
    async toExecutionPlan(args) {
      const parsed = z
        .object({
          channel: channelSchema,
          strength: z.coerce.number().int().min(0).max(200),
          waveformId: z.string().min(1).default('pulse'),
          loop: z.boolean().optional().default(true),
        })
        .parse(args);

      const waveform = await resolveWaveform(deps.waveformLibrary, parsed.waveformId);

      return {
        type: 'device',
        command: {
          type: 'start',
          channel: parsed.channel,
          strength: parsed.strength,
          waveform,
          loop: parsed.loop,
        },
      };
    },
  });

  registry.register({
    definition: {
      name: 'stop',
      description: 'Stop one channel or all channels.',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', enum: ['A', 'B'] },
        },
      },
    },
    toExecutionPlan(args) {
      const parsed = z
        .object({
          channel: channelSchema.optional(),
        })
        .parse(args);

      return {
        type: 'device',
        command: {
          type: 'stop',
          channel: parsed.channel,
        },
      };
    },
  });

  registry.register({
    definition: {
      name: 'adjust_strength',
      description: 'Adjust the strength of one channel by a delta.',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', enum: ['A', 'B'] },
          delta: { type: 'integer', minimum: -200, maximum: 200 },
        },
        required: ['channel', 'delta'],
      },
    },
    toExecutionPlan(args) {
      const parsed = z
        .object({
          channel: channelSchema,
          delta: z.coerce.number().int().min(-200).max(200),
        })
        .parse(args);

      return {
        type: 'device',
        command: {
          type: 'adjustStrength',
          channel: parsed.channel,
          delta: parsed.delta,
        },
      };
    },
  });

  registry.register({
    definition: {
      name: 'change_wave',
      description: 'Change the waveform for one channel without changing connection state.',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', enum: ['A', 'B'] },
          waveformId: { type: 'string' },
          loop: { type: 'boolean' },
        },
        required: ['channel', 'waveformId'],
      },
    },
    async toExecutionPlan(args) {
      const parsed = z
        .object({
          channel: channelSchema,
          waveformId: z.string().min(1),
          loop: z.boolean().optional().default(true),
        })
        .parse(args);

      const waveform = await resolveWaveform(deps.waveformLibrary, parsed.waveformId);

      return {
        type: 'device',
        command: {
          type: 'changeWave',
          channel: parsed.channel,
          waveform,
          loop: parsed.loop,
        },
      };
    },
  });

  registry.register({
    definition: {
      name: 'burst',
      description: 'Temporarily raise one channel to a target strength for a short duration.',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', enum: ['A', 'B'] },
          strength: { type: 'integer', minimum: 0, maximum: 200 },
          durationMs: { type: 'integer', minimum: 100, maximum: 20000 },
        },
        required: ['channel', 'strength', 'durationMs'],
      },
    },
    toExecutionPlan(args) {
      const parsed = z
        .object({
          channel: channelSchema,
          strength: z.coerce.number().int().min(0).max(200),
          durationMs: z.coerce.number().int().min(100).max(20_000),
        })
        .parse(args);

      return {
        type: 'device',
        command: {
          type: 'burst',
          channel: parsed.channel,
          strength: parsed.strength,
          durationMs: parsed.durationMs,
        },
      };
    },
  });

  registry.register({
    definition: {
      name: 'emergency_stop',
      description: 'Immediately stop all output.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    toExecutionPlan() {
      return {
        type: 'device',
        command: { type: 'emergencyStop' },
      };
    },
  });

  registry.register({
    definition: {
      name: 'timer',
      description: 'Schedule a timer that will message the assistant again after a delay.',
      parameters: {
        type: 'object',
        properties: {
          seconds: { type: 'integer', minimum: 1, maximum: 3600 },
          label: { type: 'string' },
        },
        required: ['seconds', 'label'],
      },
    },
    toExecutionPlan(args) {
      const parsed = z
        .object({
          seconds: z.coerce.number().int().min(1).max(3600),
          label: z.string().min(1),
        })
        .parse(args);

      return {
        type: 'timer',
        command: {
          type: 'timer',
          seconds: parsed.seconds,
          label: parsed.label,
        },
      };
    },
  });

  return registry;
}

async function resolveWaveform(
  waveformLibrary: WaveformLibraryPort | undefined,
  waveformId: string,
) {
  if (!waveformLibrary) {
    throw new Error(`Waveform library is unavailable; cannot resolve "${waveformId}".`);
  }

  const waveform = await waveformLibrary.getById(waveformId);
  if (!waveform) {
    throw new Error(`Unknown waveform: ${waveformId}`);
  }

  return waveform;
}
