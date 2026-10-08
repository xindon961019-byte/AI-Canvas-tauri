import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  savePendingTask: vi.fn(), updatePendingTask: vi.fn(), removePendingTask: vi.fn(), cleanupNodePolling: vi.fn(),
  registerNodePolling: vi.fn(() => new AbortController().signal),
  state: { config: { providers: { apimart: { apiKey: 'test-key', baseUrl: 'https://api.example/v1' } } }, currentProjectId: 'project', nodes: [] },
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => mocks.state } }));
vi.mock('../../src/services/pollManager', () => mocks);

import { submitSunoGeneration, submitFlowMusicGeneration } from '../../src/services/ai/apimartAudio';
import { apimartMediaProviderAdapter } from '../../src/services/ai/providers/apimartMedia';

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

describe('APIMart 音乐版本协议', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('Lyria 复用 flowmusic，显式提交 version，不将界面选择 ID 发给服务器', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ code: 200, data: [{ task_id: 'lyria-task' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(submitFlowMusicGeneration('key', 'https://api.example/v1', { version: 'lyria-3.5', soundPrompt: 'jazz', length: 60 })).resolves.toBe('lyria-task');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example/v1/music/generations');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model: 'flowmusic', version: 'lyria-3.5', sound_prompt: 'jazz', length: 60 });
  });

  it.each(['v6', 'v6-wild', 'v6-mini'] as const)('Suno %s 灵感模式省略不生效的歌词、标题和时长字段', async (version) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ code: 200, data: [{ task_id: 'suno-task' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await submitSunoGeneration('key', 'https://api.example/v1', { version, prompt: 'acoustic song', title: 'ignored', duration: 60 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ model: 'suno', version, custom: false, prompt: 'acoustic song' });
  });

  it('Suno 自定义歌词使用 prompt，风格单独写入 style', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ code: 200, data: [{ task_id: 'suno-task' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await submitSunoGeneration('key', 'https://api.example/v1', { version: 'v6', prompt: 'jazz', lyrics: '[Verse]\n夜色', title: '夜色', duration: 120 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ model: 'suno', version: 'v6', custom: true, prompt: '[Verse]\n夜色', style: 'jazz', title: '夜色', duration: 120 });
  });

  it('超长歌词、非法时长在付费提交前拒绝', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    expect(() => submitSunoGeneration('key', 'https://api.example/v1', { version: 'v6', prompt: 'jazz', lyrics: '字'.repeat(5001) })).toThrow('长度限制');
    expect(() => submitSunoGeneration('key', 'https://api.example/v1', { version: 'v6', prompt: 'jazz', lyrics: '歌词', duration: 5 })).toThrow('10–360');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['flowmusic-lyria-3.5', 'suno-v6-mini'])('%s 由 Adapter 复用可恢复的单阶段音乐任务', async (model) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ code: 200, data: [{ task_id: 'music-task' }] }))
      .mockResolvedValueOnce(json({ code: 200, data: { status: 'completed', result: { music: [{ title: '曲目', audio_url: 'https://cdn.example/music.mp3' }] } } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apimartMediaProviderAdapter.generateAudio?.({ params: { provider: 'apimart', model: `apimart/${model}`, prompt: 'jazz', nodeId: 'node', autoGenerateLyrics: true }, prompt: 'jazz', referenceAudioUrls: [] }))
      .resolves.toMatchObject({ url: 'https://cdn.example/music.mp3', title: '曲目' });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['https://api.example/v1/music/generations', 'https://api.example/v1/music/tasks/music-task?language=zh']);
    expect(mocks.savePendingTask).toHaveBeenCalledWith(expect.objectContaining({ taskType: 'apimart-flow-music', audioTaskStage: 'music', providerConfigId: 'apimart' }));
    expect(mocks.updatePendingTask).toHaveBeenCalledWith('node', expect.objectContaining({ taskId: 'music-task', submitted: true }));
    expect(mocks.removePendingTask).toHaveBeenCalledWith('node');
  });

  it('余额不足只提交一次', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: '余额不足' } }), { status: 402, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(submitSunoGeneration('key', 'https://api.example/v1', { version: 'v6', prompt: 'jazz' })).rejects.toThrow('余额不足');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('提交后取消不重投音乐任务', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementationOnce(() => { controller.abort(); return Promise.resolve(json({ code: 200, data: [{ task_id: 'music-task' }] })); });
    vi.stubGlobal('fetch', fetchMock);
    await expect(apimartMediaProviderAdapter.generateAudio?.({ params: { provider: 'apimart', model: 'apimart/suno-v6', prompt: 'jazz' }, prompt: 'jazz', referenceAudioUrls: [], signal: controller.signal })).rejects.toThrow('取消');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
