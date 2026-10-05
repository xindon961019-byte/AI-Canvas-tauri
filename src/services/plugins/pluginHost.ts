import contract from '../../../plugin-host.json';
import { version } from '../../../package.json';
import type { PluginHostInfo, PluginManifest } from '../../types/plugin';

export const PLUGIN_HOST: PluginHostInfo = { ...contract, version };

function versionParts(value: string): number[] {
  if (!/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/u.test(value)) {
    throw new Error('minHostVersion 必须是稳定版本号，例如 0.9.23');
  }
  return value.split('.').map(Number);
}

export function assertPluginCompatibility(
  manifest: Pick<PluginManifest, 'minHostVersion' | 'requiredCapabilities'>,
  host: PluginHostInfo = PLUGIN_HOST,
): void {
  if (manifest.minHostVersion !== undefined) {
    const required = versionParts(manifest.minHostVersion);
    const current = versionParts(host.version);
    const index = required.findIndex((part, i) => part !== current[i]);
    if (index !== -1 && required[index] > current[index]) {
      throw new Error(`插件需要宿主 ${manifest.minHostVersion} 或更高版本，当前为 ${host.version}`);
    }
  }
  const missing = manifest.requiredCapabilities?.filter((name) => !host.capabilities.includes(name)) ?? [];
  if (missing.length) throw new Error(`宿主不支持插件所需能力: ${missing.join(', ')}`);
}
