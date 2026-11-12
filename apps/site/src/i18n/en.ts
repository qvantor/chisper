// The texts of the English page, the shape of the others (es.ts, de.ts: a missing or extra key is a type error).
// Only what the synth on main has and shows. The names of its knobs and sections stay in English in every
// language (Wave, Detune, Blend, Unison, ENV, LFO, VELO). `{name}` is filled in (`fill` of ./index.ts).
export const en = {
  meta: {
    title: 'Chisper: Free Online Wavetable Synth in Your Browser',
    description:
      'Free online wavetable synth: two oscillators with 8-voice unison, noise, a filter, envelopes and LFOs on any knob, effects, a piano roll, MIDI and shareable presets.',
    ogImageAlt: 'Chisper, a free wavetable synth',
  },
  // the key into the synth: the header, the first section, the last one, the footer
  openSynth: 'Open the synth',
  hero: {
    h1: 'Chisper: free wavetable synth',
    // the first sentence under the title, what it has under the synth playing; **words** stand out (`marks` of
    // ./index.ts)
    lead: 'Chisper is a **free wavetable synthesizer** that runs in the browser on a computer, a Chromebook or a phone: **no download, no account**.',
    details:
      '**Two wavetable oscillators** with **supersaw unison** of up to 8 voices, a **noise oscillator**, a filter in every voice, three envelopes and four LFOs you drag onto **any knob**, distortion, delay, a compressor and reverb. Plug in a MIDI keyboard or play the computer keyboard, and record what you play in the **piano roll**.',
    listen: 'Hear it',
    screenshotAlt:
      'The Chisper synth playing chords: the waves of both oscillators, the dots of the envelopes and the LFO, the filter and the spectrum moving',
  },
  listen: {
    h2: 'Free synth presets: hear them',
    lead: 'Every sound below is a free preset of the Chisper wavetable synth, recorded straight from its output: basses, leads, plucks, keys and FX. Open one in a click, play it on your keyboard, turn any knob and save your own version, no sign-up needed.',
  },
  // what wavetable synthesis is, after the clips, before the features: a card each for how it works, the music it
  // makes and where it plays
  synthesis: {
    h2: 'What is a wavetable synth?',
    table: {
      h3: 'How wavetable synthesis works',
      text: 'A wavetable synth plays a table of single-cycle waves (frames) instead of one fixed wave. Moving through the table changes the tone as a note plays: from a soft sine to a bright saw, a vocal formant or a metallic growl. It is the sound of many modern basses, leads and pads.',
      alt: 'A wavetable: its frames stacked from a sine (frame 1) to a saw (frame 256), the Wave knob on the frame that plays',
    },
    styles: {
      h3: 'Any style of electronic music',
      text: 'With Chisper you can make music in any electronic style and beyond, from club tracks to film and game scores. Its basses, leads, pads, plucks, keys and effects fit wherever a synth does.',
      genres: [
        'House',
        'Techno',
        'Trance',
        'Drum and bass',
        'Dubstep',
        'Synthwave',
        'Lo-fi hip hop',
        'Ambient',
        'Trap',
        'Pop',
        'Hip hop',
        'EDM',
      ],
    },
    online: {
      h3: 'Free and online, nothing to install',
      text: 'Chisper is a free online wavetable synth: the same kind of synthesis as desktop wavetable synths, with nothing to install. Open it, pick a table and turn Wave to hear the frames change.',
    },
  },
  features: {
    wavetables: {
      h2: 'Wavetable oscillators with 256-frame tables',
      text: [
        'Make a sound change as it plays: the Wave knob moves through a wavetable, and the tone moves with it. Two oscillators play tables of up to 256 frames from a library sorted into folders, each change of frame fading in smoothly. Tables with a morph mark play expanded to 256 frames.',
        'Each oscillator has Oct, Semi and Fine, and Phase and Phase rand set where its voices start.',
      ],
    },
    unison: {
      h2: 'Supersaw unison: up to 8 voices',
      text: [
        'Get the wide, thick supersaw of trance and EDM leads. Up to 8 voices per oscillator: Detune spreads them in pitch, Blend sets the balance of the centre voices and the side ones (75% by default), and the side voices alternate left and right for a wide stereo sound.',
      ],
    },
    // the noise oscillator (Noise.astro): what it is (a lead, its **sounds** standing out) and its samples, what
    // noise does in a sound (a list), the text of its drawing
    noise: {
      h2: 'Noise oscillator: white, pink and brown noise, 90 samples',
      text: [
        "Add what a pitched wave can't: **the hiss of a riser**, **the snap of a drum hit**, **the breath of a pad**. The noise oscillator plays in every voice beside the two wavetable oscillators, through the same filter and ENV 1.",
        'Pick one of 90 samples, from white, pink and brown noise to hats, claps, bells, vinyl crackle, tape hiss and wind. Play it as a Loop or a One-shot; with Pitch Track it follows the keys.',
      ],
      uses: {
        h3: 'What you can make with noise',
        items: [
          { term: 'Risers and sweeps', text: 'white noise that swells and opens up into the drop.' },
          { term: 'Drum hits', text: 'the snap of a hat or a clap gives a bass or a pluck its punch.' },
          { term: 'Lo-fi texture', text: 'vinyl crackle and tape hiss for the warmth of lo-fi hip hop.' },
          { term: 'Air', text: 'a touch of pink noise makes pads and leads breathe.' },
        ],
      },
      figureAlt:
        'The colors of noise: the spectra of white noise (flat), pink (−3 dB per octave), brown (−6 dB per octave), blue (+3 dB) and violet noise (+6 dB) from 20 Hz to 20 kHz',
    },
    filter: {
      h2: 'A filter in every voice: 8 types',
      text: [
        'Every note gets its own filter, so an envelope sweeps each note of a chord on its own, as on analog polysynths. Eight types: lowpass, highpass, bandpass, low shelf, high shelf, peaking, notch and allpass, with Cutoff, Res and Gain.',
      ],
    },
    modulation: {
      h2: 'Drag-and-drop modulation: envelopes, LFOs, velocity',
      text: [
        'Make any knob move: drag the tab of a source onto it, unipolar or bipolar, with up to 64 routes, 4 per knob. The sources: three envelopes (ENV 1 is the volume) with a curve you bend on each stage, four LFOs with five shapes, shapes of your own drawn as points and ready Sidechain, Rhythm and Steps patterns, and the velocity of each note (VELO).',
        'The LFOs, the times of the envelopes and the delay sync to the tempo, with triplets and dotted notes, or follow a MIDI Clock.',
      ],
    },
    effects: {
      h2: 'Effects: distortion, delay, compressor, reverb',
      text: [
        'Finish the sound inside the synth: distortion (soft or hard clip, oversampled), a delay (normal or ping-pong, with a band filter in its feedback and a Haas stereo offset), a compressor (one band, or three bands pressed down and lifted for the dense sound of modern basses) and an algorithmic reverb of 16 lines. Drag them into any order; each has its own Mix and presets. A limiter on the master keeps the output from clipping.',
      ],
    },
    playing: {
      h2: 'Play with MIDI, the computer keyboard or touch',
      text: [
        'Play it like an instrument: a MIDI keyboard (velocity and pitch bend), the computer keyboard (with an octave shift) or the on-screen piano and its pitch wheel, on a touch screen too. Up to 12 notes in Poly, or mono, with legato and portamento.',
      ],
    },
    // the piano roll and its clip (Track.astro): what it is (a lead, the ways notes come in standing out), what it
    // does with the notes and where they go, the text of its drawing
    track: {
      h2: 'Online piano roll: record, edit and import MIDI',
      text: [
        'Turn what you play into a loop: **record** from a MIDI keyboard, the computer keyboard or the on-screen piano, **draw notes** in the piano roll or **drop in a MIDI file**. The clip, a loop of up to 32 bars, plays through the synth at its tempo.',
        'Quantize to a grid of 1/4 to 1/64 with triplets, shape the velocity, copy, duplicate and undo. Export the clip as a .mid for your DAW, or save it without signing up and share it as a link; a preset can open with its clip.',
      ],
      figureAlt:
        'The piano roll of Chisper: a four-bar loop of chords and a melody over two octaves of keys, the velocity of each note under it, the playhead in the third bar',
    },
    editor: {
      h2: 'Wavetable editor: draw or import tables',
      text: [
        'Make wavetables of your own: draw a frame by hand, turn any audio file into a table, or load the WAV wavetables you already have from other synths and wavetable packs (their clm marker is read).',
      ],
      screenshotAlt: 'The wavetable editor of Chisper: the frames of a table and the one being drawn',
    },
    presets: {
      h2: 'Free community presets, shared by link',
      text: [
        'Save a sound without signing up and share it as a link: whoever opens it hears the same sound. Browse the presets of others under Popular or search them by name, and edit your own later from the same browser.',
      ],
      cta: 'Browse the presets',
    },
  },
  // the alternative texts of the parts of the synth beside the features
  figures: {
    wavetables:
      'Both oscillators of Chisper: Osc 1 on frame 33 of the Spectral Gyro wavetable, Osc 2 an octave down on frame 17 of Growl Outer Space, each with Gain, Wave, Detune and Blend',
    unison:
      'Detune held on Osc 1: the 8 voices of its unison drawn over a saw wave, the centre ones in green',
    filter: 'The filter of Chisper: the response of a resonant lowpass, with its Cutoff, Res and Gain knobs',
    modulation:
      'Osc 2 of Chisper on the Sub Sine wavetable over ENV 1 and LFO 1: the Kick shape of LFO 1 moves the Gain of Osc 2, ENV 2 moves the Rate of LFO 1',
    effects:
      'The effects of Chisper: soft clip distortion, a ping-pong delay with its band filter, and the reverb',
    playing: 'Chisper on a phone: the synth above two rows of keys, the octave keys and the pitch wheel',
  },
  finale: {
    h2: 'Play the free online synth now',
    text: 'No download, no account: open Chisper and play the computer keyboard, a MIDI keyboard or the keys on screen.',
  },
  card: {
    categories: { bass: 'Bass', lead: 'Lead', pluck: 'Pluck', keys: 'Keys', pad: 'Pad', fx: 'FX' },
    open: 'Open in Chisper',
    play: 'Play {name}',
    seek: 'Position in {name}',
  },
  demos: {
    'biting-brass-keys':
      'Two 8-voice unisons of a Moog saw table an octave apart; LFO 1 moves both wave positions, ENV 2 opens the filter and the drive.',
    'rhodes-keys':
      'A Rhodes table in a 2-voice unison over a vibraphone table; ENV 2 on the cutoff, a slow LFO on the gains: tremolo.',
    'lo-fi-tape-keys':
      'A Wurlitzer table through soft distortion; two LFOs wobble a short delay: the tape flutter of lo-fi hip hop.',
    'ufo-drone':
      'Envelopes sweep the wave position through two tables, the pitch bend dips a tone and comes back: an ambient sci-fi drone.',
    'harp-pluck':
      'Tables of real instruments: a harp and a nylon guitar an octave above, each with its own decay.',
    'noise-riser':
      '8 + 4 unison voices for EDM build-ups; ENV 3 spreads the detune as the riser opens, the bend lifts it two semitones at the end.',
    'wind-storm':
      'Only the noise oscillator: white noise in four notes swelling through a resonant lowpass; a drawn LFO shape blows gusts into the cutoff and the noise Gain.',
    'acid-bass':
      'A mono acid bass: a snappy one-shot table and a detuned analog saw an octave up; ENV 1 snaps a resonant lowpass open on every note, LFO 1 wobbles it, soft distortion.',
    helicopter: 'A custom LFO shape chops the volume; ENV 2 speeds the LFO up like a rotor spinning up.',
    'warehouse-lead':
      'A techno lead: LFO 1 moves the wave position, a fast LFO on Fine adds grit, ENV 3 closes the filter; distortion, delay and reverb.',
    'sonar-ping': 'Three pings answered by a long delay and reverb; ENV 2 moves the band of the echoes.',
    'zesty-drive-bass':
      'A mono bass through a resonant lowpass nearly closed at 70 Hz: ENV 2 snaps it open almost four octaves on every note, then it settles; soft distortion and a ping-pong delay after it, overlapping notes glide.',
    theremin: 'Mono legato: every note glides into the next (150 ms portamento), one breath in the middle.',
    'sub-bass':
      'An 808-style sub for trap and hip hop, gliding between overlapping notes; best on headphones.',
  },
  faq: {
    h2: 'FAQ: the online wavetable synth',
    items: [
      { q: 'Is Chisper free?', a: 'Yes. Chisper is free, with no sign-up.' },
      {
        q: 'Do I need to install anything?',
        a: 'No. Chisper runs in the browser: Chrome, Edge, Safari and Firefox, on a computer or a phone. Its sound engine is written in Rust and compiled to WebAssembly SIMD. Chrome on a computer has a low-latency mode.',
      },
      {
        q: 'Does Chisper work on a Chromebook, iPad or iPhone?',
        a: "Yes. On a Chromebook, Chisper runs in Chrome as on any computer, MIDI keyboards included, so it works on school and work computers where you can't install software. On iPhone and iPad it runs in Safari (iOS 16.4 or later), on Android in Chrome; on a phone it has a layout of its own, with the keys on a screen of their own. iOS has no Web MIDI: play the keys on screen there.",
      },
      {
        q: 'Does Chisper work with my MIDI keyboard?',
        a: 'Yes. Chisper works with MIDI keyboards in browsers with Web MIDI: Chrome, Edge, Opera and Firefox on a computer, Chrome on Android. Safari (and every browser on iPhone and iPad) has no Web MIDI: play the computer keyboard or the on-screen piano there. Chisper reads notes, velocity, pitch bend and MIDI Clock.',
      },
      {
        q: 'Is Chisper good for learning synthesis?',
        a: 'Yes. Chisper shows what each knob does as you turn it: the wave each oscillator plays, the voices of the unison while Detune is held, the response of the filter, the envelopes and LFOs as curves with a dot of the note playing. Open any preset to see how its sound is made, change it and hear the difference.',
      },
      {
        q: 'Can I import any wavetables?',
        a: 'Yes. Chisper loads any WAV wavetable of 2048-sample frames, from other wavetable synths or wavetable packs (its clm marker is read). You can also make a table from a short audio file or draw one by hand.',
      },
      {
        q: 'Does Chisper have a noise oscillator?',
        a: 'Yes. Next to its two wavetable oscillators, every voice of Chisper has a noise oscillator: 90 samples, from white, pink and brown noise to hats, claps, vinyl crackle and tape hiss, looped or played once, through the filter of the voice.',
      },
      {
        q: 'Does Chisper have a piano roll?',
        a: 'Yes. Chisper has a piano roll for a looped clip of up to 32 bars and 2048 notes. Record from a MIDI keyboard, the computer keyboard or the on-screen piano, draw and edit notes and their velocity, quantize them to the grid and share the clip as a link. On a phone you add a note with a tap.',
      },
      {
        q: 'Can I import and export MIDI files?',
        a: 'Yes. Drop a .mid file (a Standard MIDI File of format 0 or 1) on the piano roll and choose its parts: its tempo and name come with it. Export the clip as a .mid to finish the track in any DAW, such as Ableton Live, FL Studio or Logic Pro.',
      },
      {
        q: 'Can I use the sounds in my tracks?',
        a: 'Yes. The sounds you play on Chisper are yours to use in your tracks, commercial releases included.',
      },
      {
        q: 'How do I share a sound?',
        a: "Save it as a preset and copy its link: whoever opens it hears the same sound, every knob, modulation and effect as you set them. To share a melody too, press Share in the piano roll: the link opens the clip with its notes and tempo; if you chose or saved a preset and haven't changed it since, the link opens that preset too (the random preset Chisper opens at start doesn't count). Check Default clip as you save a preset, and the preset opens with its clip.",
      },
      {
        q: 'Is the source code available?',
        a: 'Yes. The source code of Chisper is on GitHub, under the PolyForm Noncommercial license.',
      },
    ],
  },
  footer: {
    source: 'Source on GitHub',
    follow: 'Follow',
    languages: 'Languages',
  },
  // the line of the Open Graph image (scripts/site/og.mjs)
  og: 'Free wavetable synth',
};

export type Messages = typeof en;
