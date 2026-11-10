import { screen, within } from '@testing-library/react';

// a row of a file browser by its name (a folder's has its count after it), in a container or anywhere in the page
export const fileRow = (name: string, container?: HTMLElement) =>
  (container ? within(container) : screen).getByText(name, { selector: 'button > span' })
    .parentElement as HTMLElement;
