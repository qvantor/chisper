import {
  AnalyticsEvent,
  AnalyticsProps,
  attachAnalytics,
  featureKey,
} from '../app/common/services/analytics';

// what the app reports from now on (instead of PostHog): its events and its errors as analytics.ts gives them to
// its client (test-setup.ts forgets them after each spec)
export const recordAnalytics = () => {
  const events: { event: AnalyticsEvent; properties: AnalyticsProps; beacon: boolean }[] = [];
  const errors: { error: unknown; properties: Record<string, unknown> }[] = [];
  attachAnalytics({
    capture: (event, properties, beacon) => events.push({ event, properties, beacon }),
    captureException: (error, properties) => errors.push({ error, properties }),
  });
  return {
    events,
    errors,
    // the properties of the events of `name`
    named: (name: AnalyticsEvent) =>
      events.filter(({ event }) => event === name).map(({ properties }) => properties),
    // the features used, as `feature` or `feature:value`
    features: () =>
      events
        .filter(({ event }) => event === 'feature_used')
        .map(({ properties: { feature, value } }) => featureKey(`${feature}`, value as string | null)),
    // the fingerprints of the errors reported (none: their source)
    fingerprints: () =>
      errors.map(({ properties }) => properties['$exception_fingerprint'] ?? properties['source']),
  };
};
