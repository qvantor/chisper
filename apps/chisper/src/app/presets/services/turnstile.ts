// inlined at build time
export const TURNSTILE_SITE_KEY = process.env['NX_PUBLIC_TURNSTILE_SITE_KEY'] ?? '';

// a token not given by then (the script didn't load) drops what waited for it (a usage event, a save of a clip)
export const CAPTCHA_TIMEOUT_MS = 30 * 1000;
