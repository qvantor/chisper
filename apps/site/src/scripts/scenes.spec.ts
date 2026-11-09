import { stubBrowser } from './browser-stubs';
import { animateScenes } from './scenes';

const strokes: number[] = [];
// the dots of grain: where, their sizes and the blur they were drawn with
const dots: { y: number; size: number; blur: number }[] = [];
// the boxes of bars (x, y, width, height) and the fills with the alpha they were drawn at
const boxes: number[][] = [];
const fills: number[] = [];
// a context with roundRect, or one without (only rect)
let round = true;
const fake = () => {
  const box = (x: number, y: number, width: number, height: number) => boxes.push([x, y, width, height]);
  const context = {
    shadowBlur: 0,
    globalAlpha: 1,
    rect: box,
    ...(round && { roundRect: box }),
    clearRect: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    arc: () => undefined,
    fill: () => fills.push(context.globalAlpha),
    fillRect: (_x: number, y: number, size: number) => dots.push({ y, size, blur: context.shadowBlur }),
    stroke: () => strokes.push(1),
    setTransform: () => undefined,
    setLineDash: () => undefined,
  };
  return context;
};

let browser: ReturnType<typeof stubBrowser>;

beforeEach(() => {
  strokes.length = 0;
  dots.length = 0;
  boxes.length = 0;
  fills.length = 0;
  round = true;
  browser = stubBrowser();
  HTMLCanvasElement.prototype.getContext = (() => fake()) as never;
  document.body.innerHTML = `
    <canvas data-scene="unison"></canvas>
    <canvas data-scene="effects"></canvas>
    <canvas data-scene="nothing"></canvas>`;
});

describe('animateScenes', () => {
  it('takes the canvases of known scenes', () => {
    expect(animateScenes()).toBe(2);
  });

  it('draws a scene only while it is seen, about FPS times a second', () => {
    animateScenes();
    const [unison, effects] = document.querySelectorAll('canvas');
    browser.resized([{ target: unison }, { target: effects }]);
    // sized off screen: not drawn
    expect(strokes).toHaveLength(0);
    expect(browser.frames).toHaveLength(0);

    browser.seen([{ target: unison, isIntersecting: true }]);
    expect(browser.frames).toHaveLength(1);
    browser.step(100);
    // the 7 voices of the unison
    expect(strokes).toHaveLength(7);
    // not again within a frame of FPS
    browser.step(110);
    expect(strokes).toHaveLength(7);
    browser.step(140);
    expect(strokes).toHaveLength(14);

    browser.seen([{ target: unison, isIntersecting: false }]);
    browser.step(200);
    expect(browser.frames).toHaveLength(0);
  });

  it('draws one still frame where motion is reduced, when the scene is seen', () => {
    browser.reduced = true;
    animateScenes();
    const [unison] = document.querySelectorAll('canvas');
    browser.resized([{ target: unison }]);
    browser.seen([{ target: unison, isIntersecting: true }]);
    browser.step(16);
    expect(strokes).toHaveLength(7);
    browser.step(48);
    browser.step(96);
    expect(strokes).toHaveLength(7);
    expect(browser.frames).toHaveLength(0);
  });

  it('draws the noise as dots without a blur, no line', () => {
    document.body.innerHTML = `<canvas data-scene="noise"></canvas>`;
    animateScenes();
    const [noise] = document.querySelectorAll('canvas');
    browser.resized([{ target: noise }]);
    browser.seen([{ target: noise, isIntersecting: true }]);
    browser.step(100);
    expect(strokes).toHaveLength(0);
    expect(dots.length).toBeGreaterThan(500);
    for (const { size, blur } of dots) {
      expect(size).toBeGreaterThan(1);
      expect(blur).toBe(0);
    }
  });

  it('fills a tall section with the grain, higher than a wave may go, inside the canvas', () => {
    document.body.innerHTML = `<canvas data-scene="noise"></canvas>`;
    animateScenes();
    const [noise] = document.querySelectorAll('canvas');
    noise.getBoundingClientRect = () => ({ width: 1200, height: 1000 }) as DOMRect;
    browser.resized([{ target: noise }]);
    browser.seen([{ target: noise, isIntersecting: true }]);
    browser.step(100);
    const ys = dots.map(({ y }) => y);
    // a wave at most 220 pixels from the middle (500)
    expect(Math.min(...ys)).toBeLessThan(250);
    expect(Math.max(...ys)).toBeGreaterThan(750);
    expect(Math.min(...ys)).toBeGreaterThan(0);
    expect(Math.max(...ys)).toBeLessThan(1000);
  });

  it('draws the notes of the track as boxes in a few paths, filled fainter than their edges', () => {
    document.body.innerHTML = `<canvas data-scene="track"></canvas>`;
    animateScenes();
    const [track] = document.querySelectorAll('canvas');
    track.getBoundingClientRect = () => ({ width: 1200, height: 600 }) as DOMRect;
    browser.resized([{ target: track }]);
    browser.seen([{ target: track, isIntersecting: true }]);
    browser.step(100);
    expect(boxes.length).toBeGreaterThan(20);
    for (const [x, y, width, height] of boxes) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + width).toBeLessThanOrEqual(1200 + 1e-6);
      expect(width).toBeGreaterThan(0);
      // a note about ten pixels high, inside the canvas
      expect(height).toBeGreaterThan(6);
      expect(height).toBeLessThan(16);
      expect(y).toBeGreaterThan(0);
      expect(y + height).toBeLessThan(600);
    }
    // a path for the unlit notes and one for each light: a few strokes and fills, not one a note
    expect(strokes.length).toBeLessThan(15);
    expect(fills.length).toBeGreaterThanOrEqual(2);
    for (const alpha of fills) expect(alpha).toBeLessThan(0.5);
  });

  it('draws the notes as plain boxes where a context has no round ones', () => {
    round = false;
    document.body.innerHTML = `<canvas data-scene="track"></canvas>`;
    animateScenes();
    const [track] = document.querySelectorAll('canvas');
    browser.resized([{ target: track }]);
    browser.seen([{ target: track, isIntersecting: true }]);
    browser.step(100);
    expect(boxes.length).toBeGreaterThan(20);
  });

  it('does nothing without a 2D context', () => {
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    expect(animateScenes()).toBe(0);
  });
});
