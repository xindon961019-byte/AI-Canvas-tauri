import { describe, expect, it } from 'vitest';
import {
  AI_APP_MAX_JSON_BYTES, normalizeAiAppDefinition, normalizeAiAppInputIds,
  normalizeAiAppJson, normalizeAiAppReference,
} from '../../src/services/aiApps/aiAppSchema';

function definition() {
  return {
    version: 1, title: '素材筛选器', description: '筛选当前绑定素材',
    html: '<button>筛选</button>', css: '', code: 'app.registerAction("scan", () => ({ count: 1 }));',
    actions: [{ id: 'scan', title: '筛选', inputSchema: {
      type: 'object', properties: { keyword: { type: 'string', maxLength: 80 } }, required: ['keyword'], additionalProperties: false,
    } }],
  };
}

function reference() {
  const value = normalizeAiAppDefinition(definition());
  const sha256 = 'a'.repeat(64);
  return {
    version: 1, instanceId: 'ai-app-1', definition: { relativePath: `ai-apps/${sha256}.json`, sha256, bytes: 100 },
    title: value.title, description: value.description, revision: 1, actions: value.actions,
    inputNodeIds: ['input'], savedState: { keyword: '' }, savedResult: { count: 1 },
  };
}

describe('AI 应用数据边界', () => {
  it('只保留有界 JSON，并与输入对象解除引用', () => {
    const original = { text: '中文', count: 1, active: true, empty: null, rows: [{ name: '原始' }] };
    const saved = normalizeAiAppJson(original);
    original.rows[0].name = '修改';
    expect(saved).toEqual({ text: '中文', count: 1, active: true, empty: null, rows: [{ name: '原始' }] });
    expect(normalizeAiAppJson(Object.assign(Object.create(null), { count: 1 }))).toEqual({ count: 1 });
  });

  it.each([
    undefined, () => 1, { callback: () => 1 }, NaN, Infinity, new Date(), new AbortController(),
    Object.create({ polluted: true }), JSON.parse('{"__proto__":{"polluted":true}}'),
    { rows: [{ constructor: 'unsafe' }] }, { prototype: 'unsafe' },
  ])('拒绝函数、运行时对象和原型污染数据 %#', (value) => {
    expect(() => normalizeAiAppJson(value)).toThrow();
  });

  it('按 UTF-8 字节限制大小，并拒绝过长数组、字段、深层与循环数据', () => {
    expect(() => normalizeAiAppJson('界'.repeat(Math.floor(AI_APP_MAX_JSON_BYTES / 3) + 1))).toThrow('大小上限');
    expect(() => normalizeAiAppJson(Array(513).fill(null))).toThrow('512');
    expect(() => normalizeAiAppJson(Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`k${index}`, null])))).toThrow('字段过多');
    const circular: { next?: unknown } = {};
    circular.next = circular;
    expect(() => normalizeAiAppJson(circular)).toThrow('层级');
    expect(() => normalizeAiAppJson([[[[[[[[[null]]]]]]]]])).toThrow('层级');
  });
});

describe('AI 应用定义与动作契约', () => {
  it('保留声明的输入约束，为省略 schema 的动作补充默认对象契约', () => {
    const normalized = normalizeAiAppDefinition(definition());
    expect(normalized.actions[0].inputSchema).toEqual(definition().actions[0].inputSchema);
    expect(normalizeAiAppDefinition({ ...definition(), actions: [{ id: 'scan', title: '筛选' }] }).actions[0].inputSchema)
      .toEqual({ type: 'object', additionalProperties: true });
  });

  it.each([
    { ...definition(), runtime: 'tauri' },
    { ...definition(), version: 2 },
    { ...definition(), code: () => undefined },
    { ...definition(), actions: [] },
    { ...definition(), actions: [{ id: 'scan', title: '筛选', effect: 'file_write' }] },
    { ...definition(), actions: [{ id: 'scan', title: '筛选' }, { id: 'scan', title: '重复' }] },
    { ...definition(), actions: [{ id: 'scan', title: '筛选', inputSchema: { type: 'string' } }] },
    { ...definition(), actions: [{ id: 'scan', title: '筛选', inputSchema: { type: 'object', $ref: 'https://example.com/schema' } }] },
    { ...definition(), actions: [{ id: 'scan', title: '筛选', inputSchema: { type: 'object', properties: { constructor: { type: 'string' } } } }] },
    { ...definition(), actions: [{ id: 'scan', title: '筛选', inputSchema: { type: 'object', required: ['undeclared'] } }] },
  ])('拒绝未知能力字段和无效动作契约 %#', (value) => {
    expect(() => normalizeAiAppDefinition(value)).toThrow();
  });

  it('限制代码长度与整份定义的 UTF-8 大小', () => {
    expect(() => normalizeAiAppDefinition({ ...definition(), code: 'x'.repeat(64 * 1024 + 1) })).toThrow('JavaScript');
    expect(() => normalizeAiAppDefinition({ ...definition(), html: '界'.repeat(44_000) })).toThrow('128 KiB');
  });

  it('限制绑定数量并拒绝重复、空或非字符串 ID', () => {
    expect(normalizeAiAppInputIds(['a', 'b'])).toEqual(['a', 'b']);
    for (const value of [['a', 'a'], [''], [1], Array.from({ length: 51 }, (_, index) => `node-${index}`)]) {
      expect(() => normalizeAiAppInputIds(value)).toThrow();
    }
  });

  it('引用必须绑定内容摘要，不能夹带源码、任意路径或运行时字段', () => {
    expect(normalizeAiAppReference(reference())).toEqual(reference());
    for (const value of [
      { ...reference(), code: 'unsafe' },
      { ...reference(), controller: new AbortController() },
      { ...reference(), revision: 0 },
      { ...reference(), definition: { ...reference().definition, relativePath: '../../secret' } },
      { ...reference(), definition: { ...reference().definition, relativePath: 'ai-apps/other.json' } },
      { ...reference(), definition: { ...reference().definition, bytes: 128 * 1024 + 1 } },
    ]) expect(() => normalizeAiAppReference(value)).toThrow();
  });
});
