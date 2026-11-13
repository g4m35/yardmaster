import { selfCommand } from './connect.ts';
import { ProviderPluginSchema, type ProviderPlugin } from './provider-contract.ts';

/** Available without installation; remains disabled until explicitly configured. Works in npm and SEA. */
export function builtinProviders(): ProviderPlugin[] {
  return [ProviderPluginSchema.parse({
    kind: 'provider', apiVersion: 1, name: 'browserbase', label: 'Browserbase',
    setupHint: 'Enable browserbase, set BROWSERBASE_API_KEY, configure options.command, and explicitly permit unknown-cost usage for browser.verify. Authentication, remaining allowance and overage charges are not checked by discovery.',
    capabilities: { 'browser.verify': {
      service: 'browser', command: [...selfCommand(), '__browserbase-provider'],
      locality: 'remote', cost: 'unknown', requiredEnv: ['BROWSERBASE_API_KEY'], timeoutMs: 330_000,
    } },
  })];
}
