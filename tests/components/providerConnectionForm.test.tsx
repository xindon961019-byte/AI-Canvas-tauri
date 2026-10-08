import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ProviderConnectionForm, { CccGroupConnectionsForm } from '../../src/components/settings/providerConnection/ProviderConnectionForm';
import { getProviderDefinition } from '../../src/services/ai/providerCatalogService';
import { CCC_PROVIDER_GROUPS } from '../../src/services/ai/cccProviderGroups';

function render(providerId: string) {
  const definition = getProviderDefinition(providerId);
  if (!definition) throw new Error(`missing provider ${providerId}`);
  return renderToStaticMarkup(
    <ProviderConnectionForm
      editing={false}
      definition={definition}
      isWebSearchProvider={false}
      connectionName="测试连接"
      setConnectionName={vi.fn()}
      chatApiProtocol="anthropic-compatible"
      setChatApiProtocol={vi.fn()}
      apiKey="secret"
      setApiKey={vi.fn()}
      baseUrl="https://gateway.example/v1"
      setBaseUrl={vi.fn()}
      workflowApiKey=""
      setWorkflowApiKey={vi.fn()}
      dreaminaLoggedIn={false}
      dreaminaLoading={false}
      onDreaminaLogin={vi.fn()}
      duplicateConnectionName=""
      catalogStatus="idle"
      catalogMessage=""
      missingCredentials={false}
      onReturnToPicker={vi.fn()}
      onTestConnection={vi.fn()}
    />,
  );
}

describe('ProviderConnectionForm chat protocol selector', () => {
  it('shows all supported chat protocols for custom connections', () => {
    const html = render('custom-openai');
    expect(html).toContain('对话协议');
    expect(html).toContain('OpenAI 兼容');
    expect(html).toContain('Anthropic 兼容');
    expect(html).toContain('Gemini 原生');
    expect(html).toContain('value="anthropic-compatible" selected=""');
    expect(html).toContain('Anthropic 流式事件');
  });

  it('does not show the selector for built-in providers', () => {
    expect(render('cccapi')).not.toContain('对话协议');
  });

  it('shows the verified CCC groups and explains independent Key routing', () => {
    const html = renderToStaticMarkup(<CccGroupConnectionsForm providerConfigs={{}} presetModels={[...getProviderDefinition('cccapi')!.models!]} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(html).toContain('所有已填写分组一起保存');
    for (const group of CCC_PROVIDER_GROUPS) expect(html).toContain(group.name);
    expect(html).toContain('无需切换分组');
    expect(html).toContain('保存全部分组');
    expect(render('grsai')).not.toContain('CCC 分组');
  });
});
