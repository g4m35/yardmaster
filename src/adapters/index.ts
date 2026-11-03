import { BUILTIN_ADAPTERS, commandAdapter } from './builtin.ts';
import type { Adapter } from './types.ts';
import { agentSettings, type Config } from '../config.ts';
import { which } from '../proc.ts';

const registry = new Map<string, Adapter>(BUILTIN_ADAPTERS.map((a) => [a.name, a]));

export function registerAdapter(adapter: Adapter): void {
  registry.set(adapter.name, adapter);
}

export function getAdapter(name: string, config?: Config): Adapter | null {
  const builtin = registry.get(name);
  if (builtin) return builtin;
  const cmd = config?.agents[name]?.command;
  return cmd ? commandAdapter(name, cmd) : null;
}

export function allAdapterNames(config?: Config): string[] {
  return [...new Set([...registry.keys(), ...Object.keys(config?.agents ?? {})])];
}

/** Agents usable on this machine: installed, enabled, and not the test mock (unless asked for). */
export function detectAgents(config: Config, includeMock = false): string[] {
  return allAdapterNames(config).filter((name) => {
    if (name === 'mock' && !includeMock) return false;
    const a = getAdapter(name, config);
    if (!a || !agentSettings(config, name).enabled) return false;
    const bin = agentSettings(config, name).command?.split(/\s+/)[0] ?? a.binary;
    return which(bin) !== null;
  });
}

export type { Adapter } from './types.ts';
