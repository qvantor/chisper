import React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../app/app/query-client';

// a query client of the app's of its own (no retries: a failed query fails at once) and a wrapper of renderHook
// with it
export const queryWrapper = () => {
  const client = createQueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: React.PropsWithChildren) =>
    React.createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
};

// the answer of fetch with this status and JSON body
export const jsonResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }) as Response;
