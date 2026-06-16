import {
  createDefaultToolRegistry,
  type DefaultToolRegistryDeps,
  type ToolRegistry,
} from './tool-registry.js';
import {
  getRuntimeContextToolDefinition,
  RUNTIME_CONTEXT_TOOL_NAME,
} from './runtime-context-tool.js';

export function createAgentToolRegistry(deps: DefaultToolRegistryDeps = {}): ToolRegistry {
  const registry = createDefaultToolRegistry(deps);
  registry.register({
    name: RUNTIME_CONTEXT_TOOL_NAME,
    displayName: '读取运行上下文',
    definition: getRuntimeContextToolDefinition(),
    toExecutionPlan() {
      // RuntimeToolExecutor handles this tool directly; the registry entry exists
      // so the model can see and call it.
      return { type: 'inline', output: '{}' };
    },
  });
  return registry;
}

export { createAgentToolRegistry as createAgentToolRegistryWithDeps };
