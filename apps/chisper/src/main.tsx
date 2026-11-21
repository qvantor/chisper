import React from 'react';
import * as ReactDOM from 'react-dom/client';
import { Core } from './app';
import {
  initAnalytics,
  rootErrorHandlers,
  sessionEntry,
  siteLanguage,
} from './app/common/services/analytics';
import { readLatencyMode } from './app/synth/common/latency/latency';
import { getUrlClipId, getUrlPresetId } from './app/presets/services/url';

// the session of the analytics before React: the errors of its start are the session's (off out of production)
initAnalytics({
  lang: navigator.language.split('-')[0].toLowerCase(),
  site: siteLanguage(document.referrer),
  touch: window.matchMedia('(pointer: coarse)').matches,
  cores: navigator.hardwareConcurrency ?? null,
  memory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
  latency: readLatencyMode(),
  ...sessionEntry(getUrlPresetId(), getUrlClipId()),
});

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement, rootErrorHandlers);
root.render(<Core />);
