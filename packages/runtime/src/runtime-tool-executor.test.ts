import { describe, expect, it } from 'vitest';
import type { DeviceKind, ToolDefinition } from '@dg-agent/core';
import { filterToolDefinitionsByConnectedDevices } from './runtime-tool-executor.js';

function def(
  name: string,
  parameters: ToolDefinition['parameters'] = { type: 'object', properties: {} },
): ToolDefinition {
  return { name, description: name, parameters };
}

const ALL_DEFINITIONS: ToolDefinition[] = [
  def('start'),
  def('stop'),
  def('adjust_strength'),
  def('change_wave'),
  def('burst'),
  def('vibrate_start'),
  def('vibrate_stop'),
  def('vibrate_adjust'),
  def('set_indicator_color', {
    type: 'object',
    properties: {
      deviceKind: { type: 'string', enum: ['paw-prints', 'civet-edging', 'opossum'] },
      color: { type: 'integer' },
    },
  }),
  def('timer'),
  def('design_wave'),
];

function names(definitions: ToolDefinition[]): string[] {
  return definitions.map((d) => d.name);
}

describe('filterToolDefinitionsByConnectedDevices', () => {
  it('drops every device tool when nothing is connected, but keeps device-less tools', () => {
    const result = filterToolDefinitionsByConnectedDevices(ALL_DEFINITIONS, new Set());
    expect(names(result)).toEqual(['timer', 'design_wave']);
  });

  it('includes Coyote tools only when coyote is connected', () => {
    const connected = new Set<DeviceKind>(['coyote']);
    const result = filterToolDefinitionsByConnectedDevices(ALL_DEFINITIONS, connected);
    expect(names(result)).toEqual(
      expect.arrayContaining(['start', 'stop', 'adjust_strength', 'change_wave', 'burst']),
    );
    expect(names(result)).not.toEqual(expect.arrayContaining(['vibrate_start']));
  });

  it('includes vibrate_* tools only when opossum is connected', () => {
    const connected = new Set<DeviceKind>(['opossum']);
    const result = filterToolDefinitionsByConnectedDevices(ALL_DEFINITIONS, connected);
    expect(names(result)).toEqual(
      expect.arrayContaining(['vibrate_start', 'vibrate_stop', 'vibrate_adjust']),
    );
    expect(names(result)).not.toEqual(expect.arrayContaining(['start']));
  });

  it('drops set_indicator_color entirely when no LED-capable device is connected', () => {
    const connected = new Set<DeviceKind>(['coyote']); // coyote has no LED
    const result = filterToolDefinitionsByConnectedDevices(ALL_DEFINITIONS, connected);
    expect(names(result)).not.toEqual(expect.arrayContaining(['set_indicator_color']));
  });

  it("narrows set_indicator_color's deviceKind enum to only the connected LED-capable kinds", () => {
    const connected = new Set<DeviceKind>(['opossum', 'coyote']);
    const result = filterToolDefinitionsByConnectedDevices(ALL_DEFINITIONS, connected);
    const tool = result.find((d) => d.name === 'set_indicator_color');
    expect(tool).toBeDefined();
    const properties = (tool!.parameters as { properties: { deviceKind: { enum: string[] } } })
      .properties;
    expect(properties.deviceKind.enum).toEqual(['opossum']);
  });

  it('always keeps tools that need no device, regardless of connection state', () => {
    const result = filterToolDefinitionsByConnectedDevices(ALL_DEFINITIONS, new Set());
    expect(names(result)).toEqual(expect.arrayContaining(['timer', 'design_wave']));
  });

  it('keeps every device tool when every device kind is connected', () => {
    const connected = new Set<DeviceKind>(['coyote', 'opossum', 'paw-prints', 'civet-edging']);
    const result = filterToolDefinitionsByConnectedDevices(ALL_DEFINITIONS, connected);
    expect(names(result)).toEqual(names(ALL_DEFINITIONS));
  });
});
