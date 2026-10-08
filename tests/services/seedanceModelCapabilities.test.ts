import { describe, expect, it } from 'vitest';
import {
  applySeedanceTemplateDefaults,
  createSeedanceQuickAdaptTemplate,
  getOfficialSeedanceCapability,
  inferSeedanceModelVariant,
  resolveSeedanceAutoTemplate,
  SEEDANCE_QUICK_ADAPT_OPTIONS,
} from '../../src/services/ai/seedanceModelCapabilities';
import type { VideoModelCapability } from '../../src/types/aiTypes';

describe('Seedance capability templates', () => {
  it('declares the official 2.0 resolution tiers and adaptive ratio support', () => {
    expect(getOfficialSeedanceCapability('2.0-standard')).toMatchObject({
      resolutions: ['480p', '720p', '1080p', '4k'],
      ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
      minDuration: 4,
      maxDuration: 15,
    });
    expect(getOfficialSeedanceCapability('2.0-fast').resolutions).toEqual(['480p', '720p']);
    expect(getOfficialSeedanceCapability('2.0-mini').resolutions).toEqual(['480p', '720p']);
  });

  it('declares Seedance 2.5 automatic duration and operation-specific restrictions', () => {
    expect(getOfficialSeedanceCapability('2.5')).toMatchObject({
      resolutions: ['480p', '720p', '1080p'],
      defaultRatio: 'adaptive',
      automaticDurationValue: -1,
      operationCapabilities: {
        'video-to-video': {
          ratios: ['adaptive'],
          defaultRatio: 'adaptive',
          automaticDurationOnly: true,
        },
      },
      inputModeCapabilities: {
        keyframe: { ratios: ['adaptive'], defaultRatio: 'adaptive' },
      },
    });
  });

  it('builds a Volcano Engine native protocol with typed content and official polling', () => {
    const template = createSeedanceQuickAdaptTemplate('2.5', 'volcengine');
    expect(template.executionProfile).toMatchObject({
      preset: 'custom',
      protocol: {
        version: 2,
        mode: 'async',
        submit: {
          path: '/contents/generations/tasks',
          body: {
            content: '{{seedanceContent}}',
            ratio: '{{seedanceRatio}}',
            duration: '{{seedanceDuration}}',
          },
        },
        response: { taskIdPath: 'id' },
        poll: {
          path: '/contents/generations/tasks/{{submit.id}}',
          response: { statusPath: 'status', result: { urlPath: 'content.video_url' } },
        },
      },
    });
  });

  it('keeps APIMart transport limits and field names as a provider overlay', () => {
    const template = createSeedanceQuickAdaptTemplate('2.5', 'apimart');
    expect(template.capability).toMatchObject({
      resolutions: ['480p', '720p', '1080p'],
      defaultDuration: 5,
    });
    expect(template.capability.automaticDurationValue).toBe(-1);
    expect(template.capability).not.toHaveProperty('operationCapabilities');
    expect(getOfficialSeedanceCapability('2.5').operationCapabilities?.['video-to-video']?.automaticDurationOnly).toBe(true);
    expect(template.executionProfile.protocol?.submit).toMatchObject({
      path: '/videos/generations',
      body: {
        size: '{{seedanceRatio}}',
        image_with_roles: '{{imageWithRoles}}',
      },
    });
    const protocol = template.executionProfile.protocol;
    expect(protocol && 'response' in protocol ? protocol.response : undefined).toMatchObject({
      taskIdPath: 'data.0.task_id',
    });
  });

  it('returns independent clones and exposes all explicit transport choices', () => {
    const first = createSeedanceQuickAdaptTemplate('2.5', 'volcengine');
    const second = createSeedanceQuickAdaptTemplate('2.5', 'volcengine');
    first.capability.ratios?.push('test-only');
    expect(second.capability.ratios).not.toContain('test-only');
    expect(SEEDANCE_QUICK_ADAPT_OPTIONS).toHaveLength(12);
  });

  it.each([
    ['doubao-seedance-2-0-260128', '2.0-standard'],
    ['apimart/doubao-seedance-2.0-fast', '2.0-fast'],
    ['lec-gt-seedance-2-0-mini', '2.0-mini'],
    ['lec-seed-2-5-900', '2.5'],
    ['seedance_2.5_character', '2.5'],
  ] as const)('infers %s as %s', (modelId, expected) => {
    expect(inferSeedanceModelVariant(modelId)).toBe(expected);
  });

  it('does not mistake unrelated 2.5 models for Seedance', () => {
    expect(inferSeedanceModelVariant('agnes-video-2.5')).toBeUndefined();
    expect(inferSeedanceModelVariant('seedream-5.0-pro')).toBeUndefined();
  });

  it('matches the Lec protocol and exact per-line capability overrides', () => {
    const official = resolveSeedanceAutoTemplate({
      modelId: 'lec-gt-seedance-2-5-720p',
      baseUrl: 'https://api.paipu.net/v1',
    });
    expect(official).toMatchObject({
      templateId: '2.5:lec',
      capability: {
        resolutions: ['480p', '720p', '1080p'],
        minDuration: 12,
        maxDuration: 30,
        defaultDuration: 12,
      },
      executionProfile: {
        preset: 'custom',
        protocol: {
          submit: {
            path: '/v1/videos',
            pathMode: 'origin',
            body: {
              aspect_ratio: '{{seedanceRatio}}',
              images: '{{imageUrls}}',
              videos: '{{videoUrls}}',
              audios: '{{audioUrls}}',
            },
          },
          poll: {
            path: '/v1/videos/{{submit.id}}',
            pathMode: 'origin',
            response: { result: { urlPath: 'url' } },
          },
        },
      },
    });
    expect(official?.capability).not.toHaveProperty('automaticDurationValue');

    expect(resolveSeedanceAutoTemplate({
      modelId: 'lec-seedance-2-5-30s',
      baseUrl: 'https://api.paipu.net',
    })?.capability).toMatchObject({
      resolutions: ['720p'],
      durations: [30],
      maxImageReferences: 30,
      maxVideoReferences: 0,
      maxAudioReferences: 0,
    });
    expect(resolveSeedanceAutoTemplate({
      modelId: 'lec-ac-seedance-2-5-all-reference',
      baseUrl: 'https://api.paipu.net',
    })?.capability).toMatchObject({
      resolutions: ['720p'],
      minDuration: 4,
      maxDuration: 30,
      maxImageReferences: 30,
      maxVideoReferences: 0,
      maxAudioReferences: 10,
    });
  });

  it('returns capability-only defaults for an unverified relay', () => {
    const match = resolveSeedanceAutoTemplate({
      modelId: 'doubao-seedance-2-5-260628',
      baseUrl: 'https://ailingg.store/v1',
    });
    expect(match?.model).toBe('2.5');
    expect(match?.executionProfile).toBeUndefined();
    expect(match?.capability.maxImageReferences).toBe(30);
  });

  it('only fills missing fields and preserves explicit user configuration', () => {
    const existingCapability: VideoModelCapability = { operations: ['text-to-video'], durations: [8] };
    const existingProfile = { preset: 'custom' as const, protocol: {
      version: 2 as const,
      mode: 'sync' as const,
      submit: { method: 'POST' as const, path: '/custom' },
      response: { type: 'json' as const, result: { urlPath: 'url' } },
    } };
    const model = applySeedanceTemplateDefaults({
      id: 'lec-gt-seedance-2-0-full',
      name: 'Seedance',
      category: 'video',
      provider: 'custom-test',
      videoCapability: existingCapability,
      executionProfile: existingProfile,
    }, 'https://api.paipu.net');
    expect(model.videoCapability).toBe(existingCapability);
    expect(model.executionProfile).toBe(existingProfile);
  });

  it('respects an explicit non-video manual category', () => {
    const model = applySeedanceTemplateDefaults({
      id: 'doubao-seedance-2-5-260628',
      name: 'Not a video model here',
      category: 'text',
      categoryManual: true,
      provider: 'custom-test',
    }, 'https://ark.cn-beijing.volces.com/api/v3');
    expect(model.category).toBe('text');
    expect(model.videoCapability).toBeUndefined();
    expect(model.executionProfile).toBeUndefined();
  });
});
