import { filterKnobLooks, formatCutoff, formatEqGain } from './knobs';

const labels = (type: string) => {
  const { resonance, gain, variation } = filterKnobLooks(type);
  return [resonance.label, gain.label, variation.label];
};

describe('filterKnobLooks', () => {
  it('names Res a Q where it is one (a Biquad BP, Notch, Bell), the variation Gain on the EQ types', () => {
    expect(labels('lowpass')).toEqual(['Res', 'Gain', 'Comp']);
    expect(labels('highpass')[0]).toBe('Res');
    ['bandpass', 'notch', 'peaking'].forEach((type) => expect(labels(type)[0]).toBe('Q'));
    expect(labels('ladder24')).toEqual(['Res', 'Gain', 'Comp']);
    ['loweq6', 'loweq12', 'bandeq12', 'higheq6', 'higheq12'].forEach((type) =>
      expect(filterKnobLooks(type).variation).toMatchObject({ label: 'Gain', name: 'Filter band gain' })
    );
  });

  it('names every knob Filter …, the Gain of an EQ type apart from the Gain of a Biquad one', () => {
    ['lowpass', 'bandpass', 'lowshelf', 'peaking', 'ladder24', 'low6', 'loweq12', 'bandeq12'].forEach(
      (type) => {
        const names = Object.values(filterKnobLooks(type)).map(({ name }) => name);
        names.forEach((name) => expect(name).toMatch(/^Filter /));
        expect(new Set(names).size).toBe(names.length);
      }
    );
    expect(filterKnobLooks('ladder24').resonance.name).toBe('Filter resonance');
    expect(filterKnobLooks('lowpass').resonance.name).toBe('Filter resonance');
    expect(filterKnobLooks('ladder24').variation.name).toBe('Filter compensation');
  });

  it('shows each value with its unit', () => {
    const ladder = filterKnobLooks('ladder24');
    expect(ladder.resonance.format(55)).toBe('55%');
    expect(ladder.resonance.format(12.3)).toBe('12.3%');
    expect(ladder.drive.format(40)).toBe('40%');
    expect(ladder.variation.format(100)).toBe('100%');
    expect(filterKnobLooks('lowpass').resonance.format(6)).toBe('+6.0dB');
    expect(filterKnobLooks('lowpass').resonance.format(0)).toBe('0.0dB');
    expect(filterKnobLooks('bandpass').resonance.format(0.7071)).toBe('0.707');
    expect(filterKnobLooks('bandpass').resonance.format(250)).toBe('250');
    expect(filterKnobLooks('lowshelf').gain.format(-12)).toBe('-12.0dB');
    expect(filterKnobLooks('peaking').gain.format(9)).toBe('+9.0dB');
  });

  it('shows the cutoff in Hz, over 1 kHz in kHz', () => {
    expect(formatCutoff(440)).toBe('440Hz');
    expect(formatCutoff(999.6)).toBe('1000Hz');
    expect(formatCutoff(2500)).toBe('2.50kHz');
    expect(formatCutoff(12345)).toBe('12.3kHz');
  });

  it('shows the Gain of an EQ type as the gain of its band: -∞ at 0, 0 dB at 50 %, +19 dB at 100 %', () => {
    expect(formatEqGain(0)).toBe('-∞dB');
    expect(formatEqGain(50)).toBe('0.0dB');
    expect(formatEqGain(100)).toBe('+19.1dB');
    expect(formatEqGain(25)).toBe('-1.2dB');
    expect(formatEqGain(75)).toBe('+6.0dB');
  });
});
