import type { ModelProtocolPresetId, NormalizedModelExecutionProtocol } from '../../types/aiTypes';
import { parseModelExecutionProtocol } from '../../services/ai/modelProtocol';

export type ProtocolChoice = ModelProtocolPresetId | 'legacy';

/**
 * 试跑的前置条件；返回 null 表示可以真发请求。
 * 「自动兼容」不走声明式协议，运行时直接调标准端点，没有协议可跑。
 */
export function describeProtocolTestRunBlocker(
  preset: ProtocolChoice,
  apiKey: string,
  baseUrl: string,
  invalidDraft = false,
): 'legacy-preset' | 'missing-base-url' | 'missing-api-key' | 'invalid-draft' | null {
  if (preset === 'legacy') return 'legacy-preset';
  if (!baseUrl.trim()) return 'missing-base-url';
  if (!apiKey.trim()) return 'missing-api-key';
  if (invalidDraft) return 'invalid-draft';
  return null;
}

/** 试跑使用当前草稿；子表单无效时不能退回上一次有效协议。 */
export function resolveProtocolTestRunDraft(
  preset: ProtocolChoice,
  protocol: NormalizedModelExecutionProtocol,
  jsonDraft: string,
  invalidFormFields = false,
): NormalizedModelExecutionProtocol {
  if (invalidFormFields) throw new Error('请修正表单中的 JSON 错误');
  return parseModelExecutionProtocol(preset === 'custom' ? JSON.parse(jsonDraft) : protocol);
}
