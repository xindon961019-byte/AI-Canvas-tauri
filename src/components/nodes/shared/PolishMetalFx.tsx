import { useLayoutEffect, useRef } from 'react';
import {
  MetalFx,
  createInstance,
  destroyInstance,
  isMetalFxSupported,
  useMetalBend,
  BEND_DEFAULTS,
  type MetalFxInstance,
  type MetalFxProps,
} from '../../../vendor/generation-effects/metal-fx/src';

const getSendBendConfig = () => BEND_DEFAULTS;

function BendingMetalFx(props: MetalFxProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  useMetalBend(rootRef, getSendBendConfig);
  return <MetalFx ref={rootRef} {...props} />;
}

/** Keep the shared renderer alive across React StrictMode's effect replay. */
export default function PolishMetalFx(props: MetalFxProps) {
  const lease = useRef<MetalFxInstance | null>(null);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    if (releaseTimer.current !== null) clearTimeout(releaseTimer.current);
    releaseTimer.current = null;
    if (!lease.current && isMetalFxSupported()) {
      // metal-fx 2.0.10's old context-loss event can stop a newly created
      // renderer. A paused lease prevents teardown during synchronous replay;
      // it draws once, then costs no animation frames when the button unmounts.
      lease.current = createInstance({
        hostCanvas: document.createElement('canvas'),
        cssWidth: 1,
        cssHeight: 1,
        cornerRadius: 0,
        kind: 'pill',
        ringCssPx: 0,
        paused: true,
      });
    }
    return () => {
      releaseTimer.current = setTimeout(() => {
        if (lease.current) destroyInstance(lease.current);
        lease.current = null;
        releaseTimer.current = null;
      }, 0);
    };
  }, []);

  return props.variant === 'circle' ? <BendingMetalFx {...props} /> : <MetalFx {...props} />;
}
