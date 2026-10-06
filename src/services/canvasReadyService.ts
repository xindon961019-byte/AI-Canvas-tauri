/** 项目数据已加载、视口已挂载后的显示等待；不修改画布或项目状态。 */
export function waitForCanvasFirstPaint(
  fitView: () => Promise<unknown>,
  onReady: () => void,
): () => void {
  let cancelled = false;
  let painting = false;
  let layoutFrame = 0;
  let paintFrame = 0;
  const schedulePaint = () => {
    if (cancelled || painting) return;
    painting = true;
    clearTimeout(deadline);
    layoutFrame = requestAnimationFrame(() => {
      paintFrame = requestAnimationFrame(() => {
        if (!cancelled) onReady();
      });
    });
  };
  // 虚拟化画布的离屏节点可能尚未测量，fitView 的内部队列不能无限阻挡进入。
  const deadline = setTimeout(schedulePaint, 2000);
  void Promise.resolve().then(() => {
    if (!cancelled) return fitView();
  }).then(schedulePaint, schedulePaint);
  return () => {
    cancelled = true;
    clearTimeout(deadline);
    cancelAnimationFrame(layoutFrame);
    cancelAnimationFrame(paintFrame);
  };
}
