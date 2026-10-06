import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryRecord } from '../../src/services/indexedDbService';
import type { AssetImageRecord } from '../../src/types/assetImage';

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
});

function history(id: string, projectId: string, filePath: string, timestamp: number): HistoryRecord {
  return { id, projectId, filePath, timestamp, nodeId: 'image-node', nodeLabel: '图片', nodeType: 'ai-image',
    prompt: `提示词 ${id}`, output: `https://images.test/${id}.png`, model: 'image-model', provider: 'provider', status: 'success' };
}

describe('asset image generation details', () => {
  it('saves edits separately from generation history and rejects stale/concurrent revisions atomically', async () => {
    const db = await import('../../src/services/indexedDbService');
    await db.putHistoryEntries([history('original', 'a', '/image.png', 1)]);
    await db.putAssetMeta({ assetId: 'asset', tags: ['角色'], updatedAt: 1 });
    const record: AssetImageRecord = { id: 'asset-image:asset:digest', assetId: 'asset', contentDigest: 'a'.repeat(64),
      prompt: '用户提示词', fileName: 'image.png', references: [], revision: 1, updatedAt: 1 };
    const results = await Promise.allSettled([db.putAssetImageRecord(record, 0), db.putAssetImageRecord({ ...record, prompt: '并发编辑' }, 0)]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    await db.putAssetImageRecord({ ...record, prompt: '第二次编辑', revision: 2 }, 1);
    await expect(db.putAssetImageRecord({ ...record, prompt: '过期草稿', revision: 2 }, 1)).rejects.toThrow();
    expect((await db.getAssetImageRecords())[0]).toMatchObject({ prompt: '第二次编辑', revision: 2 });
    expect((await db.findImageHistoryByReferences(['/image.png']))?.prompt).toBe('提示词 original');
    expect((await db.getAllAssetMeta())[0].tags).toEqual(['角色']);
    const controller = new AbortController(); controller.abort();
    await expect(db.getAssetImageRecords(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('matches exact Windows paths and encoded local asset URLs without guessing filenames', async () => {
    const db = await import('../../src/services/indexedDbService');
    await db.putHistoryEntries([
      history('exact', 'a', 'D:\\素材\\人物\\hero.png', 1),
      history('same-name', 'a', 'D:\\其他\\hero.png', 2),
      { ...history('failed', 'a', 'D:/素材/人物/hero.png', 3), status: 'error' },
    ]);
    const record = await db.findImageHistoryByReferences(['https://asset.localhost/D%3A%5C%E7%B4%A0%E6%9D%90%5C%E4%BA%BA%E7%89%A9%5Chero.png']);
    expect(record?.id).toBe('exact');
    expect((await db.findImageHistoryByReferences(['d:/素材/人物/hero.png']))?.id).toBe('exact');
    expect(await db.findImageHistoryByReferences(['/missing/hero.png'])).toBeNull();
  });

  it('uses the latest successful record and honors the explicitly selected project', async () => {
    const db = await import('../../src/services/indexedDbService');
    await db.putHistoryEntries([history('a', 'a', '/shared/image.png', 10), history('b', 'b', '/shared/image.png', 20)]);
    expect((await db.findImageHistoryByReferences(['/shared/image.png']))?.id).toBe('b');
    expect((await db.findImageHistoryByReferences(['/shared/image.png'], 'a'))?.id).toBe('a');
    expect(await db.findImageHistoryByReferences(['/shared/image.png'], 'missing')).toBeNull();
    expect(await db.getHistoryEntryCount('a')).toBe(1);
    expect(await db.getHistoryEntryCount('b')).toBe(1);
  });

  it('matches saved media addresses exactly, excludes text/video and does not strip URL signatures', async () => {
    const db = await import('../../src/services/indexedDbService');
    await db.putHistoryEntries([
      { ...history('image', 'a', '/local/image.png', 1), mediaUrl: 'https://images.test/a.png?signature=a' },
      { ...history('video', 'a', '/local/image.png', 2), nodeType: 'ai-video' },
    ]);
    expect((await db.findImageHistoryByReferences(['https://images.test/a.png?signature=a']))?.id).toBe('image');
    expect(await db.findImageHistoryByReferences(['https://images.test/a.png?signature=b'])).toBeNull();
    expect(await db.findImageHistoryByReferences(['data:image/png;base64,fixture'])).toBeNull();
  });

  it('loads through the asset identity and supports cancellation without changing retained history', async () => {
    const db = await import('../../src/services/indexedDbService');
    const details = await import('../../src/services/assetImageDetails');
    await db.putHistoryEntries([history('source', 'project', '/library/image.png', 1)]);
    const file = { path: '/library/image.png', name: 'image.png', category: 'image' as const, size: 20 };
    expect((await details.loadAssetImageHistory(file, 'project'))?.prompt).toBe('提示词 source');
    const controller = new AbortController(); controller.abort();
    await expect(details.loadAssetImageHistory(file, undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await db.getHistoryEntryCount('project')).toBe(1);
  });

  it('shows only stored parameter values and excludes arbitrary objects, paths and secrets', async () => {
    const { describeAssetImageHistory } = await import('../../src/services/assetImageDetails');
    const rows = describeAssetImageHistory({ ...history('source', 'a', '/image.png', 0), params: {
      imageSize: '2K', aspectRatio: '16:9', seed: 0, steps: 28, quality: '',
      guidanceScale: Number.NaN, apiKey: 'test-only-secret', filePath: '/private/example',
      references: ['data:image/png;base64,fixture'], sampler: { name: 'hidden-object' },
    } });
    expect(rows).toEqual([
      { label: '模型', value: 'image-model' }, { label: '供应商', value: 'provider' },
      { label: '生成尺寸', value: '2K' }, { label: '宽高比', value: '16:9' },
      { label: '随机种子', value: '0' }, { label: '采样步数', value: '28' },
    ]);
    expect(JSON.stringify(rows)).not.toContain('test-only-secret');
  });

  it('resolves reference images mentioned in prompts from nodes, assets, and history', async () => {
    const db = await import('../../src/services/indexedDbService');
    const { resolvePromptImageReferences } = await import('../../src/services/assetImageDetails');

    await db.putHistoryEntries([
      { ...history('hist-node', 'project-a', '/hist.png', 10), nodeId: 'node-from-hist', nodeLabel: '历史节点', mediaUrl: 'https://images.test/hist.png' },
    ]);

    const prompt = '韩系美女跳舞 @{node-canvas:生成图像} @asset{%2Fassets%2Fref.png} @drama{char_1:林小满} @{node-from-hist:历史节点}';
    const nodes = [
      { id: 'node-canvas', data: { label: '生成图像', type: 'ai-image', imageUrl: 'https://images.test/canvas.png' } },
    ];
    const dramaAssets = {
      characters: [
        { id: 'char_1', name: '林小满', kind: 'character' as const, imageUrl: 'https://images.test/lin.png' },
      ],
      scenes: [],
      props: [],
    };

    const refs = await resolvePromptImageReferences(prompt, {
      nodes: nodes as never,
      dramaAssets: dramaAssets as never,
      projectId: 'project-a',
    });

    expect(refs).toHaveLength(4);
    expect(refs[0]).toMatchObject({ name: '生成图像', url: 'https://images.test/canvas.png' });
    expect(refs[1]).toMatchObject({ name: 'ref.png', url: '/assets/ref.png' });
    expect(refs[2]).toMatchObject({ name: '林小满', url: 'https://images.test/lin.png' });
    expect(refs[3]).toMatchObject({ name: '历史节点', url: 'https://images.test/hist.png' });
  });
});
