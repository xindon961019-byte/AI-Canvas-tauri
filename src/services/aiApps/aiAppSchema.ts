import type { AgentToolSchema } from '../chat/agentToolSchemas';
import type { AiAppAction, AiAppDefinition, AiAppJson, AiAppReference } from '../../types/aiApp';
import { assertProjectFileReference } from '../fs/projectFiles';

export const AI_APP_MAX_DEFINITION_BYTES = 128 * 1024;
export const AI_APP_MAX_JSON_BYTES = 64 * 1024;
export const AI_APP_MAX_INPUTS = 50;
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const idPattern = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${label} 必须是普通对象`);
  }
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).some((key) => forbiddenKeys.has(key) || !keys.includes(key))) {
    throw new Error(`${label} 包含不支持的字段`);
  }
}

function string(value: unknown, label: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && !value.trim())) {
    throw new Error(`${label} 必须是${allowEmpty ? '不超过' : '非空且不超过'} ${maxLength} 字符的文本`);
  }
  return value;
}

/** 只接收有界 JSON，函数、原型污染键和循环引用都留在边界外。 */
export function normalizeAiAppJson(value: unknown, maxBytes = AI_APP_MAX_JSON_BYTES): AiAppJson {
  let count = 0;
  const visit = (item: unknown, depth: number): AiAppJson => {
    if (depth > 8 || ++count > 4096) throw new Error('应用数据层级或条目过多');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string' && item.length <= maxBytes) return item;
    if (Array.isArray(item)) {
      if (item.length > 512) throw new Error('应用数组不能超过 512 项');
      return item.map((entry) => visit(entry, depth + 1));
    }
    const raw = record(item, '应用数据');
    const entries = Object.entries(raw);
    if (entries.length > 128 || entries.some(([key]) => forbiddenKeys.has(key) || key.length > 128)) {
      throw new Error('应用数据字段过多或包含不安全字段');
    }
    return Object.fromEntries(entries.map(([key, entry]) => [key, visit(entry, depth + 1)]));
  };
  const result = visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > maxBytes) throw new Error('应用数据超过大小上限');
  return result;
}

function normalizeSchema(value: unknown, depth = 0): AgentToolSchema {
  if (depth > 5) throw new Error('动作参数 schema 层级过深');
  const raw = record(value, '动作参数 schema');
  knownKeys(raw, ['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum',
    'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'], '动作参数 schema');
  if (!['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(String(raw.type))) {
    throw new Error('动作参数 schema 类型不受支持');
  }
  const result: AgentToolSchema = { type: raw.type as AgentToolSchema['type'] };
  if (raw.description !== undefined) result.description = string(raw.description, '参数说明', 1000, true);
  if (raw.properties !== undefined) {
    const properties = record(raw.properties, '参数字段');
    if (Object.keys(properties).length > 32 || Object.keys(properties).some((key) => forbiddenKeys.has(key) || !idPattern.test(key))) {
      throw new Error('动作参数字段无效或过多');
    }
    result.properties = Object.fromEntries(Object.entries(properties).map(([key, schema]) => [key, normalizeSchema(schema, depth + 1)]));
  }
  if (raw.required !== undefined) {
    if (!Array.isArray(raw.required) || raw.required.length > 32
      || raw.required.some((key) => typeof key !== 'string' || !Object.hasOwn(result.properties ?? {}, key))) {
      throw new Error('动作必填参数必须已在 properties 中声明');
    }
    result.required = [...new Set(raw.required as string[])];
  }
  if (raw.additionalProperties !== undefined) {
    if (typeof raw.additionalProperties !== 'boolean') throw new Error('additionalProperties 必须是布尔值');
    result.additionalProperties = raw.additionalProperties;
  }
  if (raw.items !== undefined) result.items = normalizeSchema(raw.items, depth + 1);
  if (raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || raw.enum.length === 0 || raw.enum.length > 64
      || raw.enum.some((item) => !['string', 'number', 'boolean'].includes(typeof item)
        || (typeof item === 'number' && !Number.isFinite(item))
        || (typeof item === 'string' && item.length > 1000))) throw new Error('动作枚举参数无效');
    result.enum = raw.enum as Array<string | number | boolean>;
  }
  for (const key of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) throw new Error('动作参数范围无效');
    if (key !== 'minimum' && key !== 'maximum' && (!Number.isSafeInteger(raw[key]) || raw[key] < 0)) {
      throw new Error('动作参数长度范围无效');
    }
    result[key] = raw[key];
  }
  return result;
}

function normalizeActions(value: unknown): AiAppAction[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) throw new Error('应用必须声明 1–12 个动作');
  const seen = new Set<string>();
  return value.map((entry) => {
    const raw = record(entry, '应用动作');
    knownKeys(raw, ['id', 'title', 'description', 'inputSchema'], '应用动作');
    const id = string(raw.id, '动作 ID', 64);
    if (!idPattern.test(id) || seen.has(id)) throw new Error('动作 ID 无效或重复');
    seen.add(id);
    const action: AiAppAction = {
      id, title: string(raw.title, '动作名称', 80),
      inputSchema: normalizeSchema(raw.inputSchema ?? { type: 'object', additionalProperties: true }),
    };
    if (action.inputSchema.type !== 'object') throw new Error('动作输入必须为 object schema');
    if (raw.description !== undefined) action.description = string(raw.description, '动作说明', 1000, true);
    return action;
  });
}

export function normalizeAiAppDefinition(value: unknown): AiAppDefinition {
  const raw = record(value, '应用定义');
  knownKeys(raw, ['version', 'title', 'description', 'html', 'css', 'code', 'actions'], '应用定义');
  if (raw.version !== 1) throw new Error('不支持的应用定义版本');
  const definition: AiAppDefinition = {
    version: 1, title: string(raw.title, '应用名称', 120),
    description: string(raw.description ?? '', '应用说明', 2000, true),
    html: string(raw.html ?? '', '应用 HTML', 64 * 1024, true),
    css: string(raw.css ?? '', '应用 CSS', 32 * 1024, true),
    code: string(raw.code, '应用 JavaScript', 64 * 1024),
    actions: normalizeActions(raw.actions),
  };
  if (new TextEncoder().encode(JSON.stringify(definition)).byteLength > AI_APP_MAX_DEFINITION_BYTES) {
    throw new Error('应用定义超过 128 KiB 上限');
  }
  return definition;
}

export function normalizeAiAppInputIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > AI_APP_MAX_INPUTS
    || value.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 200)) {
    throw new Error('应用输入必须为最多 50 个节点 ID');
  }
  if (new Set(value).size !== value.length) throw new Error('应用输入节点不能重复');
  return [...value] as string[];
}

export function normalizeAiAppReference(value: unknown): AiAppReference {
  const raw = record(value, '应用节点');
  knownKeys(raw, ['version', 'instanceId', 'definition', 'title', 'description', 'revision', 'actions', 'inputNodeIds', 'savedState', 'savedResult'], '应用节点');
  if (raw.version !== 1 || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1) {
    throw new Error('应用节点版本无效');
  }
  const definition = assertProjectFileReference(raw.definition, AI_APP_MAX_DEFINITION_BYTES);
  if (definition.relativePath !== `ai-apps/${definition.sha256}.json`) throw new Error('应用定义路径与摘要不匹配');
  return {
    version: 1, instanceId: string(raw.instanceId, '应用实例 ID', 200), definition,
    title: string(raw.title, '应用名称', 120), description: string(raw.description, '应用说明', 2000, true),
    revision: raw.revision as number, actions: normalizeActions(raw.actions),
    inputNodeIds: normalizeAiAppInputIds(raw.inputNodeIds), savedState: normalizeAiAppJson(raw.savedState),
    ...(raw.savedResult === undefined ? {} : { savedResult: normalizeAiAppJson(raw.savedResult) }),
  };
}
