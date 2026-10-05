import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { animate, motion, useReducedMotion } from 'framer-motion';
import { springGentle } from '../../utils/motion';

export interface TabItem<T extends string = string> {
  value: T;
  label: ReactNode;
  count?: number;
  disabled?: boolean;
}

export interface TabsProps<T extends string = string> {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  className?: string;
  'aria-label': string;
}

/** 带计数的受控页签；选中项居中，末项靠右，滚动边界保留弹性回弹。 */
export default function Tabs<T extends string>({
  items, value, onChange, size = 'md', className = '', 'aria-label': ariaLabel,
}: TabsProps<T>) {
  const reduceMotion = useReducedMotion();
  const listRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const revealRef = useRef<(() => void) | null>(null);
  const itemKeys = JSON.stringify(items.map((item) => item.value));
  const focusValue = items.find((item) => item.value === value && !item.disabled)?.value
    ?? items.find((item) => !item.disabled)?.value;

  useEffect(() => {
    const list = listRef.current;
    const content = contentRef.current;
    if (!list || !content) return;
    let stopAnimation = () => {};

    const reveal = () => {
      stopAnimation();
      const tab = content.querySelector<HTMLButtonElement>('[aria-selected="true"]');
      if (!tab) return;
      // 内容层是按钮的 offsetParent，计算不受面板进场缩放影响。
      const maxScrollLeft = Math.max(0, content.offsetWidth - list.clientWidth);
      const targetLeft = tab === content.lastElementChild
        ? maxScrollLeft
        : tab.offsetLeft + tab.offsetWidth / 2 - list.clientWidth / 2;
      const left = Math.min(maxScrollLeft, Math.max(0, targetLeft));
      if (Math.abs(left - list.scrollLeft) <= 1) return;
      if (reduceMotion) {
        list.scrollTo({ left, behavior: 'instant' });
        return;
      }

      const animation = animate(list.scrollLeft, left, {
        ...springGentle,
        bounce: 0.35,
        onUpdate: (position) => {
          const bounded = Math.min(maxScrollLeft, Math.max(0, position));
          list.scrollLeft = bounded;
          // 原生滚动到达边界后，由内容层呈现最多 12px 的弹性越位。
          const overscroll = Math.min(12, Math.max(-12, bounded - position));
          content.style.transform = `translate3d(${overscroll}px, 0, 0)`;
        },
        onComplete: () => {
          list.scrollLeft = left;
          content.style.removeProperty('transform');
        },
      });
      stopAnimation = () => {
        animation.stop();
        content.style.removeProperty('transform');
      };
    };

    revealRef.current = reveal;
    reveal();
    let listWidth = list.clientWidth;
    let contentWidth = content.offsetWidth;
    const observer = new ResizeObserver(() => {
      if (listWidth === list.clientWidth && contentWidth === content.offsetWidth) return;
      listWidth = list.clientWidth;
      contentWidth = content.offsetWidth;
      reveal();
    });
    observer.observe(list);
    observer.observe(content);
    const interrupt = () => stopAnimation();
    list.addEventListener('wheel', interrupt, { passive: true });
    list.addEventListener('pointerdown', interrupt);
    return () => {
      stopAnimation();
      observer.disconnect();
      revealRef.current = null;
      list.removeEventListener('wheel', interrupt);
      list.removeEventListener('pointerdown', interrupt);
    };
  }, [itemKeys, reduceMotion, size, value]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: T) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const enabled = items.filter((item) => !item.disabled);
    const index = enabled.findIndex((item) => item.value === current);
    if (index === -1) return;
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowRight': nextIndex = (index + 1) % enabled.length; break;
      case 'ArrowLeft': nextIndex = (index - 1 + enabled.length) % enabled.length; break;
      case 'Home': nextIndex = 0; break;
      case 'End': nextIndex = enabled.length - 1; break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    const next = enabled[nextIndex].value;
    const button = Array.from(contentRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
      .find((element) => element.dataset.tabValue === next);
    button?.focus({ preventScroll: true });
    if (next !== value) onChange(next);
    else revealRef.current?.();
  };

  return (
    <div ref={listRef} role="tablist" aria-label={ariaLabel} aria-orientation="horizontal"
      tabIndex={-1} data-overlay-scrollbar="off"
      className={`ui-tabs${size === 'sm' ? ' ui-tabs--sm' : ''}${className ? ` ${className}` : ''}`}>
      <div ref={contentRef} className="ui-tabs__content">
        {items.map((item) => (
          <motion.button key={item.value} type="button" role="tab" data-tab-value={item.value}
            aria-selected={value === item.value} disabled={item.disabled}
            tabIndex={item.value === focusValue ? 0 : -1}
            className={`ui-tabs__item${value === item.value ? ' is-active' : ''}`}
            onClick={() => {
              if (item.disabled) return;
              if (item.value !== value) onChange(item.value);
              else revealRef.current?.();
            }}
            onKeyDown={(event) => handleKeyDown(event, item.value)}
            whileHover={reduceMotion || item.disabled ? undefined : { scale: value === item.value ? 1 : 1.03 }}
            whileTap={reduceMotion || item.disabled ? undefined : { scale: 0.97 }}>
            {item.label}
            {item.count !== undefined && <span className="ui-tabs__count">{item.count}</span>}
          </motion.button>
        ))}
      </div>
    </div>
  );
}
