/**
 * SubAgentPanel — AI 助手内的子智能体配置面板（8.19）。
 *
 * 与项目记忆面板同构：覆盖在对话区之上，复用设置页的表单实现。
 */
import { Icon } from '@iconify/react';
import PopupCloseButton from '../shared/PopupCloseButton';
import SubAgentSettings from '../settings/SubAgentSettings';
import { mergeSubAgentProfiles } from '../../services/chat/subAgentProfileService';
import { useAppStore } from '../../store/useAppStore';
import { useT } from '../../i18n';

interface SubAgentPanelProps {
  onClose: () => void;
}

export default function SubAgentPanel({ onClose }: SubAgentPanelProps) {
  const t = useT();
  const subAgentProfiles = useAppStore((state) => state.subAgentProfiles);
  const total = mergeSubAgentProfiles(subAgentProfiles).length;

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-canvas-bg">
      <div className="flex items-center justify-between border-b border-canvas-border px-2.5 py-2">
        <div className="flex items-center gap-2">
          <Icon icon="lucide:users-round" width="16" className="text-brand" />
          <span className="text-sm font-medium text-canvas-text">{t('子智能体')}</span>
          <span className="text-[11px] text-canvas-text-muted">{t('{count} 个', { count: total })}</span>
        </div>
        <PopupCloseButton onClick={onClose} />
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden p-3">
        <SubAgentSettings hideHeading />
      </div>
    </div>
  );
}
