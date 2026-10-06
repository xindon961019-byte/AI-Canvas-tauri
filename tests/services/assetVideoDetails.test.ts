import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryRecord } from '../../src/services/indexedDbService';

beforeEach(() => { vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory()); });
afterEach(() => vi.unstubAllGlobals());
function history(id: string, projectId = 'project', filePath = '/video.mp4', timestamp = 1): HistoryRecord {
  return { id, projectId, filePath, timestamp, nodeId: 'video-node', nodeLabel: '视频', nodeType: 'ai-video',
    prompt: `提示词 ${id}`, output: `https://videos.test/${id}.mp4`, model: 'video-model', provider: 'provider', status: 'success' };
}
describe('asset video generation details', () => {
  it('按完整本地路径匹配，只读成功视频记录且不猜测同名文件', async () => {
    const db = await import('../../src/services/indexedDbService');
    await db.putHistoryEntries([history('exact', 'project', 'D:\\素材\\video.mp4'),
      history('same-name', 'project', 'D:/other/video.mp4', 2),
      { ...history('image', 'project', 'D:/素材/video.mp4', 3), nodeType: 'ai-image' },
      { ...history('failed', 'project', 'D:/素材/video.mp4', 4), status: 'error' }]);
    expect((await db.findVideoHistoryByReferences(['https://asset.localhost/D%3A%5C%E7%B4%A0%E6%9D%90%5Cvideo.mp4']))?.id).toBe('exact');
    expect((await db.findVideoHistoryByReferences(['d:/素材/video.mp4']))?.id).toBe('exact');
    expect(await db.findVideoHistoryByReferences(['/missing/video.mp4'])).toBeNull();
    expect(await db.getHistoryEntryCount('project')).toBe(4);
  });
  it('限定项目并选择最近成功记录，保留媒体地址的签名', async () => {
    const db = await import('../../src/services/indexedDbService');
    await db.putHistoryEntries([history('old'), history('new', 'project', '/video.mp4', 2),
      { ...history('other', 'other', '/video.mp4', 3), mediaUrl: 'https://videos.test/a.mp4?sig=a' }]);
    expect((await db.findVideoHistoryByReferences(['/video.mp4']))?.id).toBe('other');
    expect((await db.findVideoHistoryByReferences(['/video.mp4'], 'project'))?.id).toBe('new');
    expect((await db.findVideoHistoryByReferences(['https://videos.test/a.mp4?sig=a']))?.id).toBe('other');
    expect(await db.findVideoHistoryByReferences(['https://videos.test/a.mp4?sig=b'])).toBeNull();
    expect(await db.findVideoHistoryByReferences(['blob:temporary'])).toBeNull();
  });
  it('服务支持取消，读取不修改持久化历史', async () => {
    const db = await import('../../src/services/indexedDbService');
    const details = await import('../../src/services/assetVideoDetails');
    await db.putHistoryEntries([history('source')]);
    expect((await details.loadAssetVideoHistory('/video.mp4', undefined, 'project'))?.id).toBe('source');
    const request = new AbortController(); request.abort();
    await expect(details.loadAssetVideoHistory('/video.mp4', undefined, 'project', request.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await db.getHistoryEntryCount('project')).toBe(1);
  });
  it('展示真实生成字段并排除凭据、路径、嵌套对象及无效数字', async () => {
    const { describeAssetVideoHistory } = await import('../../src/services/assetVideoDetails');
    expect(describeAssetVideoHistory({ ...history('source'), timestamp: 0, params: {
      seedanceResolution: '1080p', seedanceRatio: '16:9', seedanceDuration: 5,
      videoFps: 24, generateAudio: false, seed: 0, quality: '', duration: Number.NaN,
      apiKey: 'test-secret', filePath: '/private/example', references: ['hidden'], negativePrompt: { hidden: true },
    } })).toEqual([
      { label: '模型', value: 'video-model' }, { label: '供应商', value: 'provider' },
      { label: '请求分辨率', value: '1080p' }, { label: '请求宽高比', value: '16:9' }, { label: '请求时长', value: '5 秒' },
      { label: '视频帧率', value: '24' }, { label: '生成音频', value: '否' }, { label: '随机种子', value: '0' },
    ]);
  });
});
