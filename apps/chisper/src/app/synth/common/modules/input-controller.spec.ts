import { createInputController } from '../../../../test-utils/models';
import { NoteOff, NoteOn, sourceKey } from './input-controller';

describe('inputController', () => {
  it('emits pressed notes and tracks them per octave', () => {
    const [{ $onPress, $pressed }, { onPress }] = createInputController();
    const pressed: NoteOn[] = [];
    $onPress.subscribe((note) => pressed.push(note));

    onPress([4, 'C']);
    onPress([4, 'E'], 30);
    onPress([-1, 'A'], 127);

    // the computer keyboard and the piano play 100
    expect(pressed).toEqual([
      { note: [4, 'C'], velocity: 100, source: 'keys' },
      { note: [4, 'E'], velocity: 30, source: 'keys' },
      { note: [-1, 'A'], velocity: 127, source: 'keys' },
    ]);
    expect($pressed.value[4]).toEqual(['C', 'E']);
    expect($pressed.value[-1]).toEqual(['A']);
    expect($pressed.value[3]).toEqual([]);
  });

  it('ignores a note that is already pressed', () => {
    const [{ $onPress, $pressed }, { onPress }] = createInputController();
    const listener = jest.fn();
    $onPress.subscribe(listener);

    onPress([4, 'C']);
    onPress([4, 'C']);

    expect(listener).toHaveBeenCalledTimes(1);
    expect($pressed.value[4]).toEqual(['C']);
  });

  it('emits released notes and removes them from pressed', () => {
    const [{ $onRelease, $pressed }, { onPress, onRelease }] = createInputController();
    const listener = jest.fn();
    $onRelease.subscribe(listener);

    onPress([4, 'C']);
    onPress([4, 'E']);
    onRelease([4, 'C']);

    expect(listener).toHaveBeenCalledWith({ note: [4, 'C'], source: 'keys' });
    expect($pressed.value[4]).toEqual(['E']);
  });

  it('allows pressing a note again after release', () => {
    const [{ $onPress }, { onPress, onRelease }] = createInputController();
    const listener = jest.fn();
    $onPress.subscribe(listener);

    onPress([4, 'C']);
    onRelease([4, 'C']);
    onPress([4, 'C']);

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('holds the notes of each source apart: the same note of two of them is two notes', () => {
    const [{ $onPress, $onRelease, $pressed, held }, { onPress, onRelease }] = createInputController();
    const presses: NoteOn[] = [];
    const releases: NoteOff[] = [];
    $onPress.subscribe((note) => presses.push(note));
    $onRelease.subscribe((note) => releases.push(note));

    onPress([4, 'C']);
    onPress([4, 'C'], 90, { source: 'midi' });
    onPress([4, 'C'], 90, { source: 'midi' });
    expect(presses.map(({ source }) => source)).toEqual(['keys', 'midi']);
    expect($pressed.value[4]).toEqual(['C']);
    expect(held.has(sourceKey('midi', [4, 'C']))).toBe(true);

    // a release of another source's note is nothing
    onRelease([4, 'C'], { source: 'roll' });
    expect(releases).toEqual([]);
    onRelease([4, 'C'], { source: 'midi' });
    expect(releases).toEqual([{ note: [4, 'C'], source: 'midi' }]);
    expect($pressed.value[4]).toEqual(['C']);
    onRelease([4, 'C']);
    expect($pressed.value[4]).toEqual([]);
  });

  it('passes the time of a note of the track on, lights none of its notes', () => {
    const [{ $onPress, $onRelease, $pressed }, { onPress, onRelease }] = createInputController();
    const presses: NoteOn[] = [];
    const releases: NoteOff[] = [];
    $onPress.subscribe((note) => presses.push(note));
    $onRelease.subscribe((note) => releases.push(note));

    onPress([4, 'C'], 64, { source: 'track', at: 1.5 });
    expect(presses).toEqual([{ note: [4, 'C'], velocity: 64, source: 'track', at: 1.5 }]);
    expect($pressed.value[4]).toEqual([]);
    onRelease([4, 'C'], { source: 'track', at: 2 });
    expect(releases).toEqual([{ note: [4, 'C'], source: 'track', at: 2 }]);
  });

  it('holds the pitch bend at rest until it is set', () => {
    const [{ $bend }, { setBend }] = createInputController();
    expect($bend.value).toBe(0);
    setBend(-0.25);
    expect($bend.value).toBe(-0.25);
  });
});
