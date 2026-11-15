import React from 'react';
import { render, screen } from '@testing-library/react';
import { FilterRange } from '../types';
import { drawn, svgPath } from '../../common/test-utils/canvas';
import { withElementSize } from '../../common/test-utils/element-size';
import { FilterResponse } from './filter-response';

const WIDTH = 160;
const HEIGHT = 80;

// jsdom has no layout: every observed element reports a fixed size
let restoreSize: () => void;
beforeAll(() => {
  restoreSize = withElementSize(WIDTH, HEIGHT);
});
afterAll(() => restoreSize());

// the response line on the canvas of the chart
const drawnLine = () => drawn(screen.getByTestId('filter-line')).find(({ op }) => op === 'stroke');

const points = (sampleRate: number) => {
  render(<FilterResponse type='bandpass' cutoff={1000} resonance={1} sampleRate={sampleRate} />);
  const line = drawnLine();
  return { coords: line?.points ?? [], offset: line?.transform };
};

describe('FilterResponse', () => {
  it.each([48000, 32000])('draws the line from the left edge to the right edge at %i Hz', (sampleRate) => {
    const { coords, offset } = points(sampleRate);
    // the padding of the chart
    expect(offset).toEqual([1, 0, 0, 1, 0, 1]);
    expect(coords[0][0]).toBeCloseTo(0);
    expect(coords[coords.length - 1][0]).toBeCloseTo(WIDTH);
  });

  it('fills the area between the line and 0 dB, the middle of the chart', () => {
    render(<FilterResponse type='lowpass' cutoff={1000} resonance={10} sampleRate={48000} />);
    const fill = drawn(screen.getByTestId('filter-line')).find(({ op }) => op === 'fill');
    const middle = (HEIGHT - 2) / 2;
    expect(fill?.closed).toBe(true);
    // the area closes along 0 dB from the right edge back to the left one
    expect(fill?.points.slice(-2)).toEqual([
      [WIDTH, middle],
      [0, middle],
    ]);
    // the resonance over it, the slope under it
    const ys = (fill?.points ?? []).slice(0, -2).map(([, y]) => y);
    expect(Math.min(...ys)).toBeLessThan(middle - 5);
    expect(Math.max(...ys)).toBeGreaterThan(middle + 5);
  });

  it('draws its grid under the line: 0 dB across the middle, the decades', () => {
    render(<FilterResponse type='lowpass' cutoff={1000} resonance={0} sampleRate={48000} />);
    const zero = screen.getByTestId('filter-zero-db');
    expect([zero.getAttribute('y1'), zero.getAttribute('y2'), zero.getAttribute('x2')]).toEqual([
      String((HEIGHT - 2) / 2),
      String((HEIGHT - 2) / 2),
      String(WIDTH),
    ]);
    const lines = Array.from(screen.getByTestId('filter-grid').querySelectorAll('line'));
    // 100 Hz, 1 kHz, 10 kHz, ±24 dB and 0 dB
    expect(lines).toHaveLength(6);
    expect(Number(lines[1].getAttribute('x1'))).toBeCloseTo((WIDTH * 2) / Math.log10(2000));
  });

  it('keeps the line inside the chart vertically', () => {
    const { coords } = points(48000);
    coords.forEach(([, y]) => {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(HEIGHT - 2);
    });
  });
});

describe('FilterResponse following its knobs', () => {
  const ranges: Record<'cutoff' | 'resonance' | 'gain', FilterRange> = {
    cutoff: { min: 10, max: 22050, mode: 'log' },
    resonance: { min: 0, max: 20 },
    gain: { min: 0, max: 1, disabled: true },
  };
  const route = (amount: number) => [{ id: 'env2', color: '#fff', amount, level: () => 0.5, live: true }];
  const line = (props: Partial<React.ComponentProps<typeof FilterResponse>>) => {
    const { unmount } = render(
      <FilterResponse type='lowpass' cutoff={1000} resonance={4} gain={0.5} sampleRate={48000} {...props} />
    );
    const line = drawnLine();
    unmount();
    return line && svgPath(line);
  };

  it('draws the response where the routes move the knobs: as at those values', () => {
    // half of +2 octaves of the cutoff, in steps of 1/1000 of its travel (as the mark of the knob), and half of
    // +50% of the resonance
    const octaves = Math.log2(22050 / 10);
    const share = Math.round((Math.log2(1000 / 10) / octaves + 1 / octaves) * 1000) / 1000;
    const moved = line({ ranges, modulations: { cutoff: route(2 / octaves), resonance: route(0.5) } });
    expect(moved).not.toBe(line({}));
    expect(moved).toBe(line({ cutoff: 10 * 2 ** (share * octaves), resonance: 9 }));
  });

  it('draws Drive of a model type, and where its routes move it; a type without it ignores it', () => {
    const modelRanges = { ...ranges, drive: { min: 0, max: 100 } };
    const model = (props: Partial<React.ComponentProps<typeof FilterResponse>>) =>
      line({ type: 'low12', resonance: 20, ...props });
    expect(model({ drive: 50 })).not.toBe(model({ drive: 0 }));
    // a route of +50 % at half its level: Drive 25 %
    expect(model({ drive: 0, ranges: modelRanges, modulations: { drive: route(0.5) } })).toBe(
      model({ drive: 25 })
    );
    expect(line({ drive: 80 })).toBe(line({}));
  });

  it("a knob the type doesn't use, one without a travel or bypassed is drawn at its value", () => {
    const still = line({});
    expect(line({ ranges, modulations: { gain: route(1) } })).toBe(still);
    expect(line({ modulations: { cutoff: route(0.5) } })).toBe(still);
    expect(line({ ranges, modulations: { cutoff: route(0.5) }, active: false })).toBe(still);
  });
});
