import type { AgentToolSchema } from '../services/chat/agentToolSchemas';

export type AiAppJson = null | boolean | number | string | AiAppJson[] | { [key: string]: AiAppJson };

export interface AiAppAction {
  id: string;
  title: string;
  description?: string;
  inputSchema: AgentToolSchema;
}

export interface AiAppDefinition {
  version: 1;
  title: string;
  description: string;
  html: string;
  css: string;
  code: string;
  actions: AiAppAction[];
}

/** 节点只保存经过校验的代码引用，源码留在项目文件里。 */
export interface AiAppReference {
  version: 1;
  instanceId: string;
  definition: { relativePath: string; sha256: string; bytes: number };
  title: string;
  description: string;
  revision: number;
  actions: AiAppAction[];
  inputNodeIds: string[];
  savedState: AiAppJson;
  savedResult?: AiAppJson;
}

export interface AiAppResourceSnapshot {
  nodeId: string;
  label: string;
  type: string;
  status: string;
  text: string;
  truncated: boolean;
  hasImage: boolean;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface AiAppUiSnapshot {
  busy: boolean;
  closed?: boolean;
  error?: string;
  result?: AiAppJson;
  actionId?: string;
}

export interface AiAppUiSession {
  src: string;
  attach: (frame: Window | null) => void;
  dispose: () => void;
  run: (actionId: string, input?: AiAppJson) => Promise<AiAppJson>;
  save: () => Promise<void>;
  cancel: () => void;
  updateTheme: (theme: 'dark' | 'light') => void;
}
