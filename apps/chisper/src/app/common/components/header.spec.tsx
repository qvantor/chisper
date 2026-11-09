import { render, screen } from '@testing-library/react';
import { ABOUT_PATH, Header } from './header';

describe('Header', () => {
  it('links the logo to the English promo page in a new tab', () => {
    render(<Header />);
    const logo = screen.getByRole('link', { name: /CHISPER/ });
    expect(ABOUT_PATH).toBe('/wavetable-synth/');
    expect(logo.getAttribute('href')).toBe(ABOUT_PATH);
    expect(logo.getAttribute('target')).toBe('_blank');
    expect(logo.getAttribute('rel')).toBe('noopener');
    expect(logo.getAttribute('title')).toBe('About Chisper');
  });
});
