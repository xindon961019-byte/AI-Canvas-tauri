import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationContextSummary, WebSource } from '../../../src/types/chat';
import { resolveTextModelContextSpec } from '../../../src/components/nodes/shared/defaultModels';
import { estimateConversationUsage, messageContentWithSources } from '../../../src/services/chat/contextManager';
import { estimateTokens } from '../../../src/services/chat/tokenEstimate';

vi.mock('../../../src/services/chat/tokenEstimate', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/services/chat/tokenEstimate')>();
  return { ...original, estimateTokens: vi.fn(original.estimateTokens) };
});

const { estimateTokens: uncachedTokens } = await vi.importActual<typeof import('../../../src/services/chat/tokenEstimate')>(
  '../../../src/services/chat/tokenEstimate',
);
type UsageMessage = Parameters<typeof estimateConversationUsage>[0][number];
type UsageModel = NonNullable<Parameters<typeof estimateConversationUsage>[2]>;

function message(timestamp = 1): UsageMessage {
  return { role: 'assistant', content: `中文 answer ${timestamp}`, status: 'done', timestamp };
}

function source(index = 1): WebSource {
  return { id: `source-${index}`, citationId: `S${index}`, title: `来源 ${index}`,
    url: `https://example.test/${index}`, domain: 'example.test', fetchedAt: index, sourceType: 'search' };
}

function summary(coveredUntilTimestamp = 1): ConversationContextSummary {
  return { text: '摘要', coveredUntilMessageId: 'first', coveredUntilTimestamp,
    coveredMessageCount: 1, estimatedTokens: 12, updatedAt: 1 };
}

// 保留优化前的逐条计算，作为随机更新时的差分基准。
function uncachedUsage(messages: UsageMessage[], contextSummary?: ConversationContextSummary, model?: UsageModel | null) {
  const spec = resolveTextModelContextSpec(model ?? null);
  let estimatedTokens = 1_200 + (contextSummary ? contextSummary.estimatedTokens + 8 : 0);
  for (const item of messages) {
    if (item.role !== 'user' && item.role !== 'assistant') continue;
    if (!item.content) continue;
    if (contextSummary && item.timestamp <= contextSummary.coveredUntilTimestamp) continue;
    estimatedTokens += 8 + uncachedTokens(messageContentWithSources(item));
  }
  const inputBudget = spec.contextWindow - spec.outputBudget;
  return { estimatedTokens, contextWindow: spec.contextWindow, inputBudget,
    ratio: inputBudget > 0 ? estimatedTokens / inputBudget : 1, source: spec.source, modelName: model?.name };
}

beforeEach(() => vi.mocked(estimateTokens).mockClear());

describe('conversation usage cache', () => {
  it('only tokenizes changed messages while the message array and streaming reply change', () => {
    const messages = [message(1), message(2)];
    expect(estimateConversationUsage(messages, undefined, null)).toEqual(uncachedUsage(messages));
    expect(estimateTokens).toHaveBeenCalledTimes(2);
    vi.mocked(estimateTokens).mockClear();
    estimateConversationUsage([...messages], undefined, null);
    messages[0].status = 'streaming';
    estimateConversationUsage(messages, undefined, null);
    expect(estimateTokens).not.toHaveBeenCalled();

    messages[1] = { ...messages[1], content: '新回复' };
    estimateConversationUsage(messages, undefined, null);
    expect(estimateTokens).toHaveBeenCalledTimes(1);
    messages[1].content += ' 继续输出';
    expect(estimateConversationUsage(messages, undefined, null)).toEqual(uncachedUsage(messages));
    expect(estimateTokens).toHaveBeenCalledTimes(2);
  });

  it('notices source values changed in place, reordered, added, removed or replaced', () => {
    const item = { ...message(), sources: [source(1), source(2)] };
    estimateConversationUsage([item], undefined, null);
    const changes = [
      () => { item.sources[0].citationId = undefined; },
      () => { item.sources[0].title += ' 新标题'; },
      () => { item.sources[0].url += '/updated'; },
      () => { item.sources.reverse(); },
      () => { item.sources.push(source(3)); },
      () => { item.sources.pop(); },
      () => { item.sources = [source(4)]; },
      () => { item.sources = []; },
    ];
    for (const change of changes) {
      vi.mocked(estimateTokens).mockClear();
      change();
      expect(estimateConversationUsage([item], undefined, null)).toEqual(uncachedUsage([item]));
      expect(estimateTokens).toHaveBeenCalledTimes(1);
    }
  });

  it('ignores source metadata absent from the transcript and reuses equivalent source arrays', () => {
    const item = { ...message(), sources: [source()] };
    const initial = estimateConversationUsage([item], undefined, null);
    vi.mocked(estimateTokens).mockClear();
    item.sources[0].snippet = '不参与上下文的摘要';
    item.sources[0].domain = 'changed.test';
    item.sources[0].fetchedAt++;
    item.sources = item.sources.map((entry) => ({ ...entry }));
    expect(estimateConversationUsage([item], undefined, null)).toEqual(initial);
    expect(estimateTokens).not.toHaveBeenCalled();
  });

  it('reevaluates inclusive summary boundaries, mutable message fields and model budgets', () => {
    const messages = [message(1), message(2), message(2), message(3)];
    const compressed = summary(2);
    const model: UsageModel = { modelId: 'unknown', name: 'Declared', contextWindow: 8_192 };
    estimateConversationUsage(messages, undefined, model);
    vi.mocked(estimateTokens).mockClear();
    expect(estimateConversationUsage(messages, compressed, model)).toEqual(uncachedUsage(messages, compressed, model));
    expect(estimateTokens).not.toHaveBeenCalled();
    compressed.coveredUntilTimestamp = 1;
    compressed.estimatedTokens = 98;
    model.contextWindow = 32_768;
    model.name = 'Changed';
    expect(estimateConversationUsage(messages, compressed, model)).toEqual(uncachedUsage(messages, compressed, model));
    messages[3].timestamp = 1;
    messages[2].role = 'system';
    messages[1].content = '';
    expect(estimateConversationUsage(messages, compressed, model)).toEqual(uncachedUsage(messages, compressed, model));
    expect(estimateTokens).not.toHaveBeenCalled();
    for (const nextModel of [null, { modelId: 'gpt-4o', name: 'Catalog' }, { modelId: 'unknown', name: 'Default' }]) {
      expect(estimateConversationUsage(messages, undefined, nextModel)).toEqual(uncachedUsage(messages, undefined, nextModel));
    }
    messages[1].content = '恢复正文';
    messages[2].role = 'user';
    expect(estimateConversationUsage(messages, undefined, null)).toEqual(uncachedUsage(messages));
  });

  it('matches uncached results across deterministic randomized conversation edits', () => {
    let seed = 0x25a6;
    const random = (limit: number) => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return seed % limit; };
    let messages = Array.from({ length: 30 }, (_, index) => message(index));
    let compressed: ConversationContextSummary | undefined;
    const models: (UsageModel | null)[] = [null, { modelId: 'gpt-4o', name: 'Catalog' },
      { modelId: 'unknown', name: 'Declared', contextWindow: 16_384 }];
    for (let round = 0; round < 300; round++) {
      const index = random(messages.length);
      const item = messages[index];
      switch (round % 9) {
        case 0: item.content = random(3) ? `轮次${round} mixed🙂 ${'文字'.repeat(random(40))}` : ''; break;
        case 1: item.sources = Array.from({ length: random(4) }, (_, i) => source(round + i)); break;
        case 2: if (item.sources?.length) item.sources[0].title += ' 更新'; break;
        case 3: item.role = (['user', 'assistant', 'system'] as const)[random(3)]; break;
        case 4: item.timestamp = random(40); break;
        case 5: compressed = random(2) ? summary(random(40)) : undefined; break;
        case 6: messages[index] = { ...item, content: item.content + '\n流式新增' }; break;
        case 7: messages = [...messages.slice(1), message(round)]; break;
        case 8: messages.reverse(); break;
      }
      const model = models[random(models.length)];
      expect(estimateConversationUsage(messages, compressed, model), `round ${round}`)
        .toEqual(uncachedUsage(messages, compressed, model));
    }
  });
});
