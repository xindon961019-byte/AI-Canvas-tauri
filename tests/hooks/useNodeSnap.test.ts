import { describe, expect, it } from 'vitest';
import {
  buildEqualSpacingCandidates,
  findBestEqualSpacingSnap,
  type EqualSpacingCandidate,
  type NodeBounds,
} from '../../src/hooks/useNodeSnap';

function createBounds(x: number, y: number, width: number, height: number): NodeBounds {
  return {
    x,
    y,
    width,
    height,
    left: x,
    centerX: x + width / 2,
    right: x + width,
    top: y,
    centerY: y + height / 2,
    bottom: y + height,
  };
}

type Axis = Parameters<typeof buildEqualSpacingCandidates>[2];
const modes = ['start', 'center', 'end'] as const;

// 保留优化前的全配对算法，逐项核对候选内容、顺序和同坐标时的选择。
function legacyCandidates(bounds: NodeBounds[], draggedSize: number, axis: Axis): EqualSpacingCandidate[] {
  const start = (node: NodeBounds) => axis === 'horizontal' ? node.left : node.top;
  const end = (node: NodeBounds) => axis === 'horizontal' ? node.right : node.bottom;
  const cross = (node: NodeBounds, mode: typeof modes[number]) => (
    axis === 'horizontal'
      ? { start: node.top, center: node.centerY, end: node.bottom }[mode]
      : { start: node.left, center: node.centerX, end: node.right }[mode]
  );
  const pairs = new Map<string, [NodeBounds, NodeBounds]>();
  for (let i = 0; i < bounds.length; i += 1) {
    for (const mode of modes) {
      let nearest = -1;
      let nearestStart = Infinity;
      for (let j = 0; j < bounds.length; j += 1) {
        if (i === j) continue;
        const secondStart = start(bounds[j]);
        if (secondStart - end(bounds[i]) < 2 || secondStart >= nearestStart) continue;
        if (Math.abs(cross(bounds[i], mode) - cross(bounds[j], mode)) > 8) continue;
        nearest = j;
        nearestStart = secondStart;
      }
      if (nearest >= 0) pairs.set(`${i}:${nearest}`, [bounds[i], bounds[nearest]]);
    }
  }
  const candidates: EqualSpacingCandidate[] = [];
  for (const [first, second] of pairs.values()) {
    const distance = start(second) - end(first);
    const crossAlignmentModes = modes.filter((mode) => Math.abs(cross(first, mode) - cross(second, mode)) <= 8);
    candidates.push(
      { axis, targetStart: start(first) - distance - draggedSize, distance, placement: 'before', first, second, crossAlignmentModes },
      { axis, targetStart: end(second) + distance, distance, placement: 'after', first, second, crossAlignmentModes },
    );
    const equalInnerGap = (distance - draggedSize) / 2;
    if (equalInnerGap >= 2) {
      candidates.push({ axis, targetStart: end(first) + equalInnerGap, distance: equalInnerGap, placement: 'between', first, second, crossAlignmentModes });
    }
  }
  return candidates;
}

function expectLegacyGeometry(bounds: NodeBounds[], draggedSize = 80) {
  for (const axis of ['horizontal', 'vertical'] as const) {
    const expected = legacyCandidates(bounds, draggedSize, axis);
    const actual = buildEqualSpacingCandidates(bounds, draggedSize, axis);
    expect(actual).toEqual(expected);
    actual.forEach((candidate, index) => {
      expect(candidate.first).toBe(expected[index].first);
      expect(candidate.second).toBe(expected[index].second);
    });
    for (const candidate of expected.slice(0, 12)) {
      const dragged = axis === 'horizontal'
        ? createBounds(candidate.targetStart + 7, candidate.first.y, draggedSize, candidate.first.height)
        : createBounds(candidate.first.x, candidate.targetStart - 7, candidate.first.width, draggedSize);
      expect(findBestEqualSpacingSnap(dragged, actual, axis))
        .toEqual(findBestEqualSpacingSnap(dragged, expected, axis));
    }
  }
}

describe('equal-spacing node snap geometry', () => {
  it('snaps a third vertically aligned node to the existing edge gap', () => {
    const first = createBounds(100, 0, 200, 100);
    const second = createBounds(100, 140, 200, 160);
    const dragged = createBounds(100, 347, 200, 120);
    const candidates = buildEqualSpacingCandidates([first, second], dragged.height, 'vertical');

    const snap = findBestEqualSpacingSnap(dragged, candidates, 'vertical');

    expect(snap?.targetStart).toBe(340);
    expect(snap?.guide.distance).toBe(40);
    expect(snap?.guide.segments).toEqual([
      { start: 100, end: 140 },
      { start: 300, end: 340 },
    ]);
  });

  it('uses edge gaps instead of center distances for differently sized nodes', () => {
    const first = createBounds(0, 50, 100, 80);
    const second = createBounds(140, 50, 200, 80);
    const dragged = createBounds(386, 50, 80, 80);
    const candidates = buildEqualSpacingCandidates([first, second], dragged.width, 'horizontal');

    const snap = findBestEqualSpacingSnap(dragged, candidates, 'horizontal');

    expect(snap?.targetStart).toBe(380);
    expect(snap?.guide.distance).toBe(40);
  });

  it('snaps a node to equal gaps between two outer nodes', () => {
    const first = createBounds(20, 0, 100, 100);
    const second = createBounds(20, 300, 100, 100);
    const dragged = createBounds(20, 166, 100, 80);
    const candidates = buildEqualSpacingCandidates([first, second], dragged.height, 'vertical');

    const snap = findBestEqualSpacingSnap(dragged, candidates, 'vertical');

    expect(snap?.targetStart).toBe(160);
    expect(snap?.guide.distance).toBe(60);
    expect(snap?.guide.segments).toEqual([
      { start: 100, end: 160 },
      { start: 240, end: 300 },
    ]);
  });

  it('does not snap equal gaps when the nodes are not aligned on the cross axis', () => {
    const first = createBounds(0, 0, 100, 100);
    const second = createBounds(0, 140, 100, 100);
    const dragged = createBounds(80, 287, 100, 100);
    const candidates = buildEqualSpacingCandidates([first, second], dragged.height, 'vertical');

    expect(findBestEqualSpacingSnap(dragged, candidates, 'vertical')).toBeNull();
  });

  it('does not use a non-adjacent pair whose gap already contains another node', () => {
    const first = createBounds(0, 0, 100, 100);
    const middle = createBounds(0, 140, 100, 100);
    const last = createBounds(0, 280, 100, 100);
    const dragged = createBounds(0, 566, 100, 100);
    const candidates = buildEqualSpacingCandidates(
      [first, middle, last],
      dragged.height,
      'vertical',
    );

    expect(findBestEqualSpacingSnap(dragged, candidates, 'vertical')).toBeNull();
  });
});

describe('equal-spacing candidate query equivalence', () => {
  it('keeps empty and single-node inputs unchanged', () => {
    expectLegacyGeometry([]);
    expectLegacyGeometry([createBounds(-100, -50, 0, 0)]);
    expectLegacyGeometry([createBounds(-100, -50, -20, -20)]);
  });

  it('preserves ties, input order, all alignment modes, overlaps and negative sizes', () => {
    const bounds = [
      createBounds(202, 8, 100, 12),
      createBounds(0, 0, 200, 20),
      createBounds(202, -8, 100, 36),
      createBounds(202, 9, 100, 2),
      createBounds(-202, 0, 200, 20),
      createBounds(0, 0, -10, -10),
      createBounds(0, 0, 0, 0),
      createBounds(50, 5, 400, 90),
      ...Array.from({ length: 97 }, (_, index) => createBounds(1e5 + index * 1000, 1e5 + index * 1000, 100, 100)),
    ];
    expectLegacyGeometry(bounds);
    expectLegacyGeometry([...bounds].reverse(), 0);
    expectLegacyGeometry([...bounds.slice(3), ...bounds.slice(0, 3)], -20);
  });

  it.each([95, 96, 97])('keeps the same candidates across the small-set cutoff with %i nodes', (count) => {
    expectLegacyGeometry(Array.from({ length: count }, (_, index) => createBounds(
      index % 7 * 102, Math.floor(index / 7) * 108, 100, 100,
    )));
  });

  it('keeps exact gap and cross-axis thresholds, including floating-point rounding', () => {
    for (const origin of [0, -100, 1e12, -1e12, 1e16, -1e16]) {
      const bounds = [createBounds(origin, origin, 100, 100)];
      for (const gap of [1.9999, 2, 2.0001, 16]) {
        for (const cross of [-8.0001, -8, -7.9999, 0, 7.9999, 8, 8.0001]) {
          bounds.push(createBounds(origin + 100 + gap, origin + cross, 50, 75));
          bounds.push(createBounds(origin + cross, origin + 100 + gap, 75, 50));
        }
      }
      for (const extraCount of [0, 40]) {
        const unrelated = Array.from({ length: extraCount }, (_, index) => createBounds(
          origin + 1e6 + index * 1000, origin + 1e6 + index * 1000, 100, 100,
        ));
        expectLegacyGeometry([...bounds, ...unrelated], 1.9999);
      }
    }
  });

  it('matches the old algorithm on seeded mixed geometries and shuffled input', () => {
    let seed = 0x713a9;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let sample = 0; sample < 150; sample += 1) {
      const count = sample % 2 === 0 ? Math.floor(random() * 97) : 97 + Math.floor(random() * 80);
      const bounds = Array.from({ length: count }, () => createBounds(
        Math.floor(random() * 21) * 40 + (random() < 0.5 ? 0 : random() * 16 - 8),
        Math.floor(random() * 21) * 40 + (random() < 0.5 ? 0 : random() * 16 - 8),
        Math.floor(random() * 12 - 2) * 10,
        Math.floor(random() * 12 - 2) * 10,
      ));
      bounds.forEach(Object.freeze);
      Object.freeze(bounds);
      expectLegacyGeometry(bounds, Math.floor(random() * 12 - 2) * 10);
    }
  });

  it.each(['grid', 'same-row', 'same-start', 'overlap'] as const)(
    'preserves every candidate in a dense %s layout',
    (layout) => {
      const bounds = Array.from({ length: 500 }, (_, index) => {
        if (layout === 'same-row') return createBounds(index * 110, 0, 100, 100);
        if (layout === 'same-start') return createBounds((index % 3) * 110, index % 11, 100, 100);
        if (layout === 'overlap') return createBounds(index % 51, index % 31, 100 + index % 7, 100);
        return createBounds(index % 23 * 110, Math.floor(index / 23) * 110, 100, 100);
      });
      expectLegacyGeometry(bounds);
    },
  );

  it('keeps the legacy fallback for non-finite stored geometry', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expectLegacyGeometry([
        createBounds(0, 0, 100, 100), createBounds(140, 0, 100, 100),
        createBounds(value, 0, 10, 10), createBounds(0, value, 10, 10),
        ...Array.from({ length: 97 }, (_, index) => createBounds(1e5 + index * 1000, 1e5 + index * 1000, 100, 100)),
      ]);
    }
  });

  it('reads dense geometry linearly instead of once per node pair', () => {
    const count = 2000;
    let geometryReads = 0;
    const bounds = Array.from({ length: count }, (_, index) => {
      const node = createBounds(index % 45 * 110, Math.floor(index / 45) * 110, 100, 100);
      for (const key of Object.keys(node) as Array<keyof NodeBounds>) {
        const value = node[key];
        Object.defineProperty(node, key, { get: () => { geometryReads += 1; return value; } });
      }
      return node;
    });
    const horizontal = buildEqualSpacingCandidates(bounds, 80, 'horizontal');
    const vertical = buildEqualSpacingCandidates(bounds, 80, 'vertical');
    expect(horizontal.length).toBeGreaterThan(0);
    expect(vertical.length).toBeGreaterThan(0);
    expect(geometryReads).toBeLessThan(count * 100);
  });
});
