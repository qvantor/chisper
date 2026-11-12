import { render, screen } from '@testing-library/react';
import { MANUAL_PATH } from '../../common/components';
import { ManualLink } from './manual-link';

describe('ManualLink', () => {
  it('opens the English Getting started of the manual in a new tab', () => {
    render(<ManualLink />);
    const link = screen.getByRole('link', { name: 'Manual' });
    expect(MANUAL_PATH).toBe('/manual/getting-started/');
    expect(link).toHaveAttribute('href', MANUAL_PATH);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener');
  });
});
