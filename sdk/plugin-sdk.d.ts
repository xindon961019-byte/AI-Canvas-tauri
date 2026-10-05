import type {
  NodePluginInvocationInput,
  NodePluginExecutionResult,
  PluginNodeInvocationInput,
  PluginNodeExecutionResult,
} from '../src/types/plugin';

/** 默认是节点工具；自定义节点可显式指定输入和结果类型。 */
declare global {
  function definePlugin<Input extends NodePluginInvocationInput | PluginNodeInvocationInput = NodePluginInvocationInput>(definition: {
    tools: Record<string, (input: Input) =>
      (Input extends PluginNodeInvocationInput ? PluginNodeExecutionResult : NodePluginExecutionResult)
      | PromiseLike<Input extends PluginNodeInvocationInput ? PluginNodeExecutionResult : NodePluginExecutionResult>>;
  }): void;
}

export type * from '../src/types/plugin';
