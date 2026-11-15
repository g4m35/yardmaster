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
  }), ProviderPluginSchema.parse({
    kind: 'provider', apiVersion: 1, name: 'apple-simulator', label: 'Apple simulator (local Xcode)',
    setupHint: 'Enable apple-simulator with options.bundleId and options.build.app, and route device.test to it. Needs macOS with Xcode; no account. Creates, uses and deletes its own simulator under a machine-wide lease. See docs/DEVICES.md.',
    capabilities: { 'device.test': {
      service: 'device', command: [...selfCommand(), '__apple-simulator-provider'],
      locality: 'local', cost: 'free', timeoutMs: 86_400_000,
    } },
  })];
}
