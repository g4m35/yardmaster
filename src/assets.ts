import { existsSync, readFileSync } from 'node:fs';
import * as sea from 'node:sea';

/**
 * Yardmaster runs two ways: from the npm package (files on disk next to the code) and as a standalone binary
 * (a Node single-executable application, with the dashboard and skill embedded as assets). Everything that needs
 * a bundled file or needs to re-launch itself goes through here.
 */
export const inSea: boolean = (() => {
  try {
    return sea.isSea();
  } catch {
    return false;
  }
})();

export type AssetName = 'dashboard.html' | 'SKILL.md';

export function readAsset(name: AssetName, candidates: string[]): string {
  if (inSea) return sea.getAsset(name, 'utf8');
  const file = candidates.find((f) => existsSync(f));
  if (!file) throw new Error(`${name} is missing from this install`);
  return readFileSync(file, 'utf8');
}
