import type { Messages } from './en';

// written for the searches in German (Wavetable Synthesizer online kostenlos, Synthesizer im Browser), not
// translated word for word; the knobs and sections keep the names of the synth
export const de: Messages = {
  meta: {
    title: 'Chisper: Wavetable-Synthesizer online & kostenlos',
    description:
      'Kostenloser Online-Synthesizer im Browser: zwei Wavetable-Oszillatoren mit 8-stimmigem Unisono, Rauschen, Hüllkurven, LFOs, Effekte, Piano Roll und MIDI. Ohne Installation.',
    ogImageAlt: 'Chisper, ein kostenloser Wavetable-Synthesizer',
  },
  openSynth: 'Synthesizer öffnen',
  hero: {
    h1: 'Chisper: kostenloser Wavetable-Synthesizer',
    lead: 'Chisper ist ein **kostenloser Wavetable-Synthesizer**, der im Browser läuft, auf dem Computer, einem Chromebook oder dem Smartphone: **ohne Download und ohne Konto**.',
    details:
      '**Zwei Wavetable-Oszillatoren** mit **Supersaw-Unisono** aus bis zu 8 Stimmen, ein **Rausch-Oszillator**, ein eigenes Filter pro Stimme, drei Hüllkurven und vier LFOs, die du auf **jeden Regler** ziehst, Distortion, Delay, Kompressor und Reverb. Schließ ein MIDI-Keyboard an oder spiel auf der Computertastatur und nimm dein Spiel in der **Piano Roll** auf.',
    listen: 'Reinhören',
    screenshotAlt:
      'Der Synthesizer Chisper spielt Akkorde: Die Wellen beider Oszillatoren, die Punkte der Hüllkurven und des LFO, das Filter und das Spektrum bewegen sich',
  },
  listen: {
    h2: 'Kostenlose Synth-Presets zum Anhören',
    lead: 'Alle Sounds hier sind kostenlose Presets des Wavetable-Synthesizers Chisper, direkt an seinem Ausgang aufgenommen: Bässe, Leads, Plucks, Keys und FX. Öffne eines mit einem Klick, spiel es auf der Tastatur oder einem MIDI-Keyboard, dreh an jedem Regler und speichere deine eigene Version, ohne Anmeldung.',
  },
  synthesis: {
    h2: 'Was ist ein Wavetable-Synthesizer?',
    table: {
      h3: 'So funktioniert Wavetable-Synthese',
      text: 'Ein Wavetable-Synthesizer spielt statt einer festen Welle eine Tabelle von Einzelzyklus-Wellen (Frames). Fährt man durch die Tabelle, ändert sich der Klang, während die Note klingt: von einem weichen Sinus zu einem hellen Sägezahn, einem Vokal-Formanten oder einem metallischen Growl. So klingen viele moderne Bässe, Leads und Pads.',
      alt: 'Eine Wavetable: ihre Frames gestapelt von einem Sinus (Frame 1) bis zu einem Sägezahn (Frame 256), der Regler Wave auf dem Frame, der spielt',
    },
    styles: {
      h3: 'Jeder Stil elektronischer Musik',
      text: 'Mit Chisper machst du Musik in jedem elektronischen Stil und darüber hinaus, vom Club-Track bis zur Film- und Game-Musik. Seine Bässe, Leads, Pads, Plucks, Keys und Effekte passen überall, wo ein Synthesizer gebraucht wird.',
      genres: [
        'House',
        'Techno',
        'Trance',
        'Drum and Bass',
        'Dubstep',
        'Synthwave',
        'Lo-Fi-Hip-Hop',
        'Ambient',
        'Trap',
        'Pop',
        'Hip-Hop',
        'EDM',
      ],
    },
    online: {
      h3: 'Kostenlos und online, ohne Installation',
      text: 'Chisper ist ein kostenloser Online-Wavetable-Synthesizer: dieselbe Art der Synthese wie bei Wavetable-Synthesizern für den Desktop, ohne Installation. Öffne ihn, wähl eine Tabelle und dreh an Wave, um die Frames wechseln zu hören.',
    },
  },
  features: {
    wavetables: {
      h2: 'Wavetable-Oszillatoren mit 256 Frames',
      text: [
        'Lass den Klang sich verändern, während die Note klingt: Der Regler Wave fährt durch eine Wavetable, und die Klangfarbe folgt ihm. Zwei Oszillatoren spielen Wavetables mit bis zu 256 Frames aus einer nach Ordnern sortierten Bibliothek, jeder Framewechsel wird weich überblendet. Tabellen mit Morph-Markierung werden auf 256 Frames erweitert.',
        'Jeder Oszillator hat Oct, Semi und Fine, und Phase und Phase rand legen fest, wo seine Stimmen beginnen.',
      ],
      more: 'Wavetables: importieren, aus Audio erstellen, zeichnen',
    },
    unison: {
      h2: 'Supersaw-Unisono mit bis zu 8 Stimmen',
      text: [
        'Der breite, dichte Supersaw der Trance- und EDM-Leads. Bis zu 8 Stimmen pro Oszillator: Detune verstimmt sie gegeneinander, Blend regelt das Verhältnis der mittleren zu den äußeren Stimmen (Standard 75 %), und die äußeren wechseln zwischen links und rechts: ein breiter Stereoklang.',
      ],
    },
    noise: {
      h2: 'Rausch-Oszillator: weißes, rosa und braunes Rauschen, 90 Samples',
      text: [
        'Rauschen bringt, was eine gestimmte Welle nicht kann: **das Zischen eines Risers**, **den Knack eines Drum-Hits**, **den Atem eines Pads**. Der Rausch-Oszillator spielt in jeder Stimme neben den beiden Wavetable-Oszillatoren, durch dasselbe Filter und ENV 1.',
        'Wähle aus 90 Samples: weißes, rosa und braunes Rauschen, Hi-Hats, Claps, Glocken, Vinyl-Knistern, Bandrauschen und Wind. Spiel es als Loop oder One-shot; mit Pitch Track folgt es den Tasten.',
      ],
      uses: {
        h3: 'Was du mit Rauschen machen kannst',
        items: [
          { term: 'Riser und Sweeps', text: 'weißes Rauschen, das anschwillt und sich zum Drop hin öffnet.' },
          {
            term: 'Drum-Hits',
            text: 'der Snap einer Hi-Hat oder eines Claps gibt Bass und Pluck ihren Punch.',
          },
          { term: 'Lo-Fi-Textur', text: 'Vinyl-Knistern und Bandrauschen für die Wärme von Lo-Fi-Hip-Hop.' },
          { term: 'Luft', text: 'ein Hauch rosa Rauschen lässt Pads und Leads atmen.' },
        ],
      },
      figureAlt:
        'Die Farben des Rauschens: die Spektren von weißem Rauschen (flach), rosa (−3 dB pro Oktave), braunem (−6 dB pro Oktave), blauem (+3 dB) und violettem Rauschen (+6 dB) von 20 Hz bis 20 kHz',
    },
    filter: {
      h2: 'Ein Filter pro Stimme: 8 Typen',
      text: [
        'Jede Note hat ihr eigenes Filter, so öffnet eine Hüllkurve jede Note eines Akkords für sich, wie bei analogen polyphonen Synthesizern. Acht Typen: Lowpass (Tiefpass), Highpass (Hochpass), Bandpass, Low Shelf, High Shelf, Peaking, Notch und Allpass, mit Cutoff, Res und Gain.',
      ],
    },
    modulation: {
      h2: 'Modulation per Drag & Drop: Hüllkurven, LFOs, Anschlag',
      text: [
        'Bring jeden Regler in Bewegung: Zieh den Tab einer Quelle auf ihn, unipolar oder bipolar, mit bis zu 64 Routen, 4 pro Regler. Die Quellen: drei Hüllkurven (ENV 1 ist die Lautstärke) mit einstellbarer Krümmung jeder Phase, vier LFOs mit fünf Formen, eigene Formen aus Punkten und fertige Muster Sidechain, Rhythm und Steps, dazu die Anschlagstärke jeder Note (VELO).',
        'Die LFOs, die Zeiten der Hüllkurven und das Delay laufen synchron zum Tempo, mit Triolen und punktierten Noten, oder folgen einer MIDI Clock.',
      ],
      more: 'Modulation: Hüllkurven, LFOs, Anschlagstärke',
    },
    effects: {
      h2: 'Effekte: Distortion, Delay, Kompressor, Reverb',
      text: [
        'Mach den Sound im Synthesizer fertig: Distortion (Soft oder Hard Clip, mit Oversampling), ein Delay (normal oder Ping-Pong, mit Bandfilter im Feedback und Haas-Stereoversatz), ein Kompressor (ein Band oder drei Bänder, die nach unten und nach oben komprimiert werden: der dichte Sound moderner Bässe) und ein algorithmischer Reverb mit 16 Delay-Lines. Die Reihenfolge änderst du per Drag & Drop, jeder Effekt hat seinen Mix und eigene Presets. Ein Limiter auf dem Master verhindert Übersteuerung.',
      ],
    },
    playing: {
      h2: 'Spielen mit MIDI, Computertastatur oder Touchscreen',
      text: [
        'Spiel ihn wie ein Instrument: auf einem MIDI-Keyboard (Anschlagstärke und Pitch Bend), der Computertastatur (mit Oktavumschaltung) oder dem Bildschirmklavier mit seinem Pitch-Rad, auch auf dem Touchscreen. Bis zu 12 Noten in Poly, oder Mono, mit Legato und Portamento.',
      ],
      more: 'MIDI-Keyboard, Chromebook und iPad: Einrichtung und Hilfe',
    },
    track: {
      h2: 'Piano Roll online: Loops aufnehmen, Noten bearbeiten, MIDI importieren',
      text: [
        'Mach aus deinem Spiel einen Loop: **Nimm auf** mit einem MIDI-Keyboard, der Computertastatur oder dem Bildschirmklavier, **zeichne Noten** in die Piano Roll oder **zieh eine MIDI-Datei** hinein. Der Clip läuft als Loop von bis zu 32 Takten in seinem Tempo durch den Synth.',
        'Quantisiere auf ein Raster von 1/4 bis 1/64 mit Triolen, forme die Anschlagstärke, kopiere, dupliziere und mach Schritte rückgängig. Exportiere den Clip als .mid für deine DAW, oder speichere ihn ohne Anmeldung und teile ihn als Link; ein Preset kann direkt mit seinem Clip starten.',
      ],
      figureAlt:
        'Die Piano Roll von Chisper: ein Loop von vier Takten aus Akkorden und einer Melodie über zwei Oktaven Tasten, darunter die Anschlagstärke jeder Note, der Abspielkopf im dritten Takt',
    },
    editor: {
      h2: 'Wavetable-Editor: Tabellen zeichnen oder importieren',
      text: [
        'Bau eigene Wavetables: Zeichne einen Frame von Hand, mach aus jeder Audiodatei eine Tabelle oder lade die WAV-Wavetables, die du schon von anderen Synthesizern und aus Wavetable-Packs hast (ihre clm-Markierung wird gelesen).',
      ],
      screenshotAlt: 'Der Wavetable-Editor von Chisper: die Frames einer Tabelle und der gerade gezeichnete',
      more: 'WAV-Wavetable importieren oder aus Audio erstellen',
    },
    presets: {
      h2: 'Kostenlose Community-Presets per Link',
      text: [
        'Speichere einen Sound ohne Anmeldung und teile ihn per Link: Wer ihn öffnet, hört denselben Sound. Stöbere unter Popular in den Presets anderer oder suche sie nach Namen, und bearbeite deine eigenen später im selben Browser.',
      ],
      cta: 'Presets ansehen',
    },
  },
  figures: {
    wavetables:
      'Beide Oszillatoren von Chisper: Osc 1 auf Frame 33 der Wavetable Spectral Gyro, Osc 2 eine Oktave tiefer auf Frame 17 von Growl Outer Space, jeder mit Gain, Wave, Detune und Blend',
    unison:
      'Detune gehalten auf Osc 1: die 8 Stimmen des Unisonos über einer Sägezahnwelle, die mittleren in Grün',
    filter:
      'Das Filter von Chisper: die Kurve eines resonanten Lowpass, mit den Reglern Cutoff, Res und Gain',
    modulation:
      'Osc 2 von Chisper auf der Wavetable Sub Sine über ENV 1 und LFO 1: die Form Kick von LFO 1 bewegt den Gain von Osc 2, ENV 2 die Rate von LFO 1',
    effects:
      'Die Effekte von Chisper: Soft-Clip-Distortion, ein Ping-Pong-Delay mit Bandfilter und der Reverb',
    playing:
      'Chisper auf dem Smartphone: der Synthesizer über zwei Tastenreihen, die Oktavtasten und das Pitch-Rad',
  },
  finale: {
    h2: 'Jetzt kostenlos online spielen',
    text: 'Kein Download, kein Konto: Öffne Chisper und spiel auf der Computertastatur, einem MIDI-Keyboard oder den Tasten auf dem Bildschirm.',
  },
  card: {
    categories: { bass: 'Bass', lead: 'Lead', pluck: 'Pluck', keys: 'Keys', pad: 'Pad', fx: 'FX' },
    open: 'In Chisper öffnen',
    play: '{name} abspielen',
    seek: 'Position in {name}',
  },
  demos: {
    'biting-brass-keys':
      'Zwei 8-stimmige Unisonos einer Moog-Sägezahntabelle im Oktavabstand; LFO 1 bewegt beide Wave-Positionen, ENV 2 öffnet Filter und Drive.',
    'rhodes-keys':
      'Eine Rhodes-Tabelle im 2-stimmigen Unisono über einer Vibraphon-Tabelle; ENV 2 auf dem Cutoff, ein langsamer LFO auf den Pegeln: Tremolo.',
    'lo-fi-tape-keys':
      'Eine Wurlitzer-Tabelle durch weiche Distortion; zwei LFOs lassen ein kurzes Delay schwanken: das Bandflattern des Lo-Fi-Hip-Hop.',
    'ufo-drone':
      'Hüllkurven fahren die Wave-Position durch zwei Tabellen, der Pitch Bend sinkt um einen Ganzton und kehrt zurück: ein Sci-Fi-Drone für Ambient.',
    'harp-pluck':
      'Tabellen echter Instrumente: eine Harfe und eine Nylongitarre eine Oktave höher, jede mit eigenem Decay.',
    'noise-riser':
      '8 + 4 Unisono-Stimmen für EDM-Build-ups; ENV 3 fächert das Detune auf, während sich der Riser öffnet, der Bend hebt ihn am Ende um zwei Halbtöne.',
    'wind-storm':
      'Nur der Rausch-Oszillator: weißes Rauschen in vier Noten, die durch einen resonanten Tiefpass anschwellen; eine gezeichnete LFO-Form bläst Böen in Cutoff und Gain des Rauschens.',
    'acid-bass':
      'Ein Mono-Acid-Bass: eine knackige One-Shot-Tabelle und ein verstimmter Analog-Sägezahn eine Oktave höher; ENV 1 reißt einen resonanten Lowpass bei jeder Note auf, LFO 1 lässt ihn wabern, weiche Distortion.',
    helicopter:
      'Eine eigene LFO-Form zerhackt die Lautstärke; ENV 2 beschleunigt den LFO wie einen anlaufenden Rotor.',
    'warehouse-lead':
      'Ein Techno-Lead: LFO 1 bewegt die Wave-Position, ein schneller LFO auf Fine macht ihn rau, ENV 3 schließt das Filter; Distortion, Delay und Reverb.',
    'sonar-ping':
      'Drei Pings, beantwortet von einem langen Delay und Reverb; ENV 2 verschiebt das Band der Echos.',
    'zesty-drive-bass':
      'Ein Mono-Bass durch einen resonanten Tiefpass, fast geschlossen bei 70 Hz: ENV 2 reißt ihn bei jeder Note fast vier Oktaven auf, dann pendelt er sich ein; danach sanfte Distortion und ein Ping-Pong-Delay, überlappende Noten gleiten.',
    theremin:
      'Mono-Legato: Jede Note gleitet in die nächste (150 ms Portamento), in der Mitte eine Atempause.',
    'sub-bass':
      'Ein Sub im 808-Stil für Trap und Hip-Hop, der zwischen überlappenden Noten gleitet; am besten mit Kopfhörern.',
  },
  faq: {
    h2: 'Häufige Fragen zum Online-Synthesizer',
    items: [
      { q: 'Ist Chisper kostenlos?', a: 'Ja. Chisper ist kostenlos und ohne Anmeldung.' },
      {
        q: 'Muss ich etwas installieren?',
        a: 'Nein. Chisper läuft im Browser: Chrome, Edge, Safari und Firefox, auf dem Computer oder dem Smartphone. Die Klangerzeugung ist in Rust geschrieben und nach WebAssembly SIMD kompiliert. Chrome auf dem Computer hat einen Modus mit niedriger Latenz.',
      },
      {
        page: 'midi',
        q: 'Funktioniert Chisper auf Chromebook, iPad oder iPhone?',
        a: 'Ja. Auf dem Chromebook läuft Chisper in Chrome wie auf jedem Computer, auch mit MIDI-Keyboards: praktisch auf Schul- und Firmenrechnern, auf denen du nichts installieren darfst. Auf iPhone und iPad läuft es in Safari (ab iOS 16.4), auf Android in Chrome; auf dem Smartphone hat es ein eigenes Layout, mit den Tasten auf einem eigenen Bildschirm. iOS hat kein Web MIDI: Dort spielst du auf den Tasten am Bildschirm.',
      },
      {
        page: 'midi',
        q: 'Funktioniert Chisper mit meinem MIDI-Keyboard?',
        a: 'Ja. Chisper funktioniert mit MIDI-Keyboards in Browsern mit Web MIDI: Chrome, Edge, Opera und Firefox auf dem Computer, Chrome auf Android. Safari (und jeder Browser auf iPhone und iPad) hat kein Web MIDI: Dort spielst du auf der Computertastatur oder dem Bildschirmklavier. Chisper liest Noten, Anschlagstärke, Pitch Bend und MIDI Clock.',
      },
      {
        page: 'getting-started',
        q: 'Eignet sich Chisper zum Lernen von Synthese?',
        a: 'Ja. Chisper zeigt, was jeder Regler tut, während du ihn drehst: die Welle, die jeder Oszillator spielt, die Stimmen des Unisonos, solange Detune gehalten wird, die Kurve des Filters, die Hüllkurven und LFOs als Kurven mit einem Punkt der klingenden Note. Öffne ein beliebiges Preset, um zu sehen, wie sein Sound gebaut ist, ändere es und hör den Unterschied.',
      },
      {
        page: 'wavetables',
        q: 'Kann ich beliebige Wavetables importieren?',
        a: 'Ja. Chisper lädt jede WAV-Wavetable mit Frames von 2048 Samples, aus anderen Wavetable-Synthesizern oder Wavetable-Packs (ihre clm-Markierung wird gelesen). Eine Tabelle lässt sich auch aus einer kurzen Audiodatei machen oder von Hand zeichnen.',
      },
      {
        q: 'Hat Chisper einen Rauschgenerator?',
        a: 'Ja. Neben den beiden Wavetable-Oszillatoren hat jede Stimme von Chisper einen Rausch-Oszillator: 90 Samples, von weißem, rosa und braunem Rauschen bis zu Hi-Hats, Claps, Vinyl-Knistern und Bandrauschen, im Loop oder einmal gespielt, durch das Filter der Stimme.',
      },
      {
        q: 'Hat Chisper eine Piano Roll?',
        a: 'Ja. Chisper hat eine Piano Roll für einen Clip als Loop von bis zu 32 Takten und 2048 Noten. Nimm mit einem MIDI-Keyboard, der Computertastatur oder dem Bildschirmklavier auf, zeichne und bearbeite Noten und ihre Anschlagstärke, quantisiere sie auf das Raster und teile den Clip als Link. Auf dem Handy setzt du eine Note mit einem Tippen.',
      },
      {
        q: 'Kann ich MIDI-Dateien importieren und exportieren?',
        a: 'Ja. Zieh eine .mid-Datei (ein Standard MIDI File im Format 0 oder 1) auf die Piano Roll und wähle ihre Spuren: Tempo und Name kommen mit. Exportiere den Clip als .mid, um den Track in jeder DAW fertigzustellen, etwa in Ableton Live, FL Studio oder Logic Pro.',
      },
      {
        q: 'Darf ich die Sounds in meinen Tracks verwenden?',
        a: 'Ja. Die Sounds, die du auf Chisper spielst, darfst du in deinen Tracks verwenden, auch in kommerziellen Releases.',
      },
      {
        page: 'getting-started',
        q: 'Wie teile ich einen Sound?',
        a: 'Speichere ihn als Preset und kopiere den Link: Wer ihn öffnet, hört denselben Sound, mit jedem Regler, jeder Modulation und jedem Effekt so, wie du sie eingestellt hast. Um auch eine Melodie zu teilen, klick in der Piano Roll auf Share: Der Link öffnet den Clip mit seinen Noten und seinem Tempo; hast du ein Preset gewählt oder gespeichert und seitdem nicht verändert, öffnet er auch dieses Preset (das zufällige Preset, mit dem Chisper startet, zählt nicht). Setz beim Speichern eines Presets den Haken bei Default clip, dann öffnet sich das Preset mit seinem Clip.',
      },
      {
        q: 'Ist der Quellcode verfügbar?',
        a: 'Ja. Der Quellcode von Chisper liegt auf GitHub, unter der Lizenz PolyForm Noncommercial.',
      },
    ],
  },
  manual: {
    name: 'Anleitung',
    nav: 'Seiten der Anleitung',
    breadcrumbs: 'Brotkrümelnavigation',
    onThisPage: 'Auf dieser Seite',
    prev: 'Zurück',
    next: 'Weiter',
    tip: 'Tipp',
    note: 'Hinweis',
    tryIt: 'Probier es aus',
    updated: 'Aktualisiert',
    keyboard: {
      label: 'Die Tasten der Computertastatur und die Noten, die sie spielen, in Oktave 3 (Standard)',
      black: 'Schwarze Tasten',
      white: 'Weiße Tasten',
      octave: 'Oktave tiefer und höher',
    },
    compat: {
      browser: 'Browser',
      any: 'Jeder',
      system: 'System',
      midi: 'MIDI-Keyboard',
      latency: 'Latenz wählbar',
      yes: 'Ja',
      no: 'Nein',
    },
  },
  footer: {
    source: 'Quellcode auf GitHub',
    follow: 'Folgen',
    languages: 'Sprachen',
  },
  og: 'Kostenloser Wavetable-Synthesizer',
};
