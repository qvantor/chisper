// stands in for the SDK of PostHog (jest.config.ts maps its modules here): what analytics.ts calls of it, recorded
export default {
  init: jest.fn(),
  capture: jest.fn(),
  captureException: jest.fn(),
};

export const ErrorTrackingExtensions = { exceptions: class {} };
