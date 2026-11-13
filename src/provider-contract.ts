import * as z from 'zod/v4';

/** Categories describe jobs, not vendors. Custom capability IDs remain portable across implementations. */
export const SERVICE_KINDS = ['research', 'build', 'ci', 'browser', 'device', 'deploy', 'data', 'observability', 'notification'] as const;
export const ProviderIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
export const CapabilityIdSchema = z.string().regex(/^[a-z][a-z0-9.-]*$/);
export const CostKindSchema = z.enum(['free', 'included', 'metered', 'unknown']);
const JsonOptionsSchema = z.record(z.string(), z.json());

/** Commands speak the JSON stdin/stdout protocol. No shell, interpolated arguments or credential values. */
export const ProviderOperationSchema = z.object({
  service: z.enum(SERVICE_KINDS),
  command: z.array(z.string().min(1)).min(1),
  /** Existing local tools can report by exit code; remote adapters must return a completed JSON result. */
  protocol: z.enum(['json', 'command']).default('json'),
  locality: z.enum(['local', 'remote']),
  cost: CostKindSchema.default('unknown'),
  requiredEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
  timeoutMs: z.number().int().min(100).max(86_400_000).default(120_000),
}).refine(op => op.protocol !== 'command' || (op.locality === 'local' && op.cost === 'free'), 'exit-code protocol is only for free local commands');
export type ProviderOperation = z.infer<typeof ProviderOperationSchema>;

export const ProviderPluginSchema = z.object({
  kind: z.literal('provider'),
  apiVersion: z.literal(1),
  name: ProviderIdSchema.refine(name => name !== 'local', 'local is reserved for project commands'),
  label: z.string().optional(),
  setupHint: z.string().optional(),
  capabilities: z.record(CapabilityIdSchema, ProviderOperationSchema).refine(v => Object.keys(v).length > 0, 'declare at least one capability'),
});
export type ProviderPlugin = z.infer<typeof ProviderPluginSchema>;

export const ServicesConfigSchema = z.object({
  /** Installing a provider does not enable it. Options go to that provider, never into discovery output. */
  providers: z.record(ProviderIdSchema, z.object({ enabled: z.boolean().default(true), options: JsonOptionsSchema.default({}) })).default({}),
  /** Ordered, explicit candidates. No route discovers or enables an arbitrary third-party service. */
  routes: z.record(CapabilityIdSchema, z.object({
    prefer: z.array(ProviderIdSchema).min(1),
    locality: z.enum(['any', 'local', 'remote']).default('any'),
    allowedCosts: z.array(CostKindSchema).default(['free']),
  })).default({}),
  /** Account-free fallback. The user supplies each capability's real command; none is invented or downloaded. */
  local: z.record(CapabilityIdSchema, ProviderOperationSchema).default({}),
  /** Additional acceptance checks, run for artifacts and again on combined integration commits. */
  verify: z.array(z.object({ capability: CapabilityIdSchema, input: z.json().default({}) })).max(20).default([]),
}).prefault({});
export type ServicesConfig = z.infer<typeof ServicesConfigSchema>;

export const ProviderResultSchema = z.object({
  status: z.enum(['passed', 'failed', 'unknown']),
  summary: z.string().min(1).max(8000),
  data: z.json().optional(),
  artifacts: z.array(z.string().max(4096)).max(100).default([]),
  costUsd: z.number().finite().nonnegative().nullable().default(null),
});
export type ProviderResult = z.infer<typeof ProviderResultSchema>;
