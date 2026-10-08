import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../types';

const allowedNodes = new WeakSet<Node<BaseNodeData>>();

export const AI_APP_CREATION_MESSAGE = 'AI 应用节点只能由内部 Agent 或 MCP 创建';
export const AI_APP_COPY_MESSAGE = 'AI 应用节点不能复制、剪切或创建副本，请让内部 Agent 或 MCP 创建';

export function isAiAppNode(node: Node<BaseNodeData>): boolean {
  return node.type === 'ai-app' || node.data.type === 'ai-app';
}

/** 授权只跟着这个节点对象走，用完或离开同步回调就失效。 */
export function allowAiAppNodeInsertion<T>(node: Node<BaseNodeData>, operation: () => T): T {
  if (allowedNodes.has(node)) throw new Error(AI_APP_CREATION_MESSAGE);
  allowedNodes.add(node);
  try {
    return operation();
  } finally {
    allowedNodes.delete(node);
  }
}

export function assertAiAppNodeInsertion(nodes: readonly Node<BaseNodeData>[]): void {
  const apps = new Set<Node<BaseNodeData>>();
  for (const node of nodes) {
    if (!isAiAppNode(node)) continue;
    if (node.type !== 'ai-app' || node.data.type !== 'ai-app'
      || !allowedNodes.has(node) || apps.has(node)) {
      throw new Error(AI_APP_CREATION_MESSAGE);
    }
    apps.add(node);
  }
  apps.forEach((node) => allowedNodes.delete(node));
}
