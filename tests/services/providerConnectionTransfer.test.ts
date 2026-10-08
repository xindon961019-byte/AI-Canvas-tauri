import { describe, expect, it } from 'vitest';
import { parseConnectionShare, serializeConnection } from '../../src/services/ai/providerConnectionTransfer';

describe('CCC group connection transfer', () => {
  it('round trips the group and model configuration while excluding credentials', () => {
    const text = serializeConnection({ name: 'CCC API · CCC生图稳定', catalogId: 'cccapi',
      cccGroup: 'CCC生图稳定', apiKey: 'private-fixture', apiKeyRef: 'secret:provider/cccapi-fixture',
      baseUrl: 'https://cccapi.cn/v1', selectedModels: [
        { id: 'gpt-image-2', name: 'Image', category: 'image', provider: 'cccapi-fixture' },
      ] });
    expect(text).not.toContain('private-fixture');
    expect(text).not.toContain('secret:provider');
    const parsed = parseConnectionShare(text)!;
    expect(parsed.config).toMatchObject({ cccGroup: 'CCC生图稳定', apiKey: '', selectedModels: [{ id: 'gpt-image-2', provider: '' }] });
    expect(parsed.config).not.toHaveProperty('apiKeyRef');
    const payload = JSON.parse(text);
    Object.assign(payload.connection, { apiKey: 'injected', apiKeyRef: 'secret:other' });
    expect(parseConnectionShare(JSON.stringify(payload))!.config.apiKey).toBe('');
  });

  it('keeps legacy CCC imports unassigned and ignores group metadata on other providers', () => {
    const legacy = JSON.parse(serializeConnection({ name: 'CCC', catalogId: 'cccapi', apiKey: '' }));
    expect(parseConnectionShare(JSON.stringify(legacy))!.config.cccGroup).toBeUndefined();
    legacy.connection.catalogId = 'custom-openai';
    legacy.connection.cccGroup = 'CCC生图稳定';
    expect(parseConnectionShare(JSON.stringify(legacy))!.config).not.toHaveProperty('cccGroup');
  });
});
