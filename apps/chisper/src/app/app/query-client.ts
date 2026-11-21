import { QueryCache, QueryClient, QueryClientConfig } from '@tanstack/react-query';
import { captureApiError, captureLoadError } from '../common/services/analytics';
import { ApiRequestError } from '../presets/services/api';

// The query client of the app (`config`: the retries of the specs). A query whose failure the user sees and nothing
// else reports (a list of the buckets: its selector stays without options) names itself in `meta.load`; an answer
// of the API with an error that its request left unreported (a query's: presets/services/api.ts) is reported here
// too. Either once, after its retries
export const createQueryClient = (config: Omit<QueryClientConfig, 'queryCache'> = {}) =>
  new QueryClient({
    ...config,
    queryCache: new QueryCache({
      onError: (error, { meta }) => {
        if (error instanceof ApiRequestError && error.unreported)
          captureApiError(error.unreported.path, error.unreported.method, error.status);
        const load = meta?.['load'];
        if (typeof load === 'string') captureLoadError(error, load);
      },
    }),
  });
