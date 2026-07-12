// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RuntimeBanner } from '../../../src/components/layout/RuntimeBanner.tsx';
import type { RuntimeState } from '../../../src/worker/client.ts';

const loading: RuntimeState = {
  status: 'loading',
  steps: [
    { id: 'download-runtime', label: 'Downloading Python runtime (Pyodide 314.0.2, ~12 MB)', done: true },
    { id: 'install-numpy', label: 'Installing numpy', done: false },
  ],
  error: null,
};

describe('RuntimeBanner', () => {
  it('narrates steps while loading (done steps checked, current step marked)', () => {
    render(<RuntimeBanner runtime={loading} />);
    const banner = screen.getByTestId('runtime-banner');
    expect(banner.textContent).toContain('Loading compression runtime:');
    expect(banner.textContent).toContain('Downloading Python runtime');
    expect(banner.textContent).toContain('Installing numpy');
    expect(screen.getByTestId('runtime-banner-step-download-runtime').textContent).toContain('✓');
    expect(screen.getByTestId('runtime-banner-step-install-numpy').textContent).not.toContain('✓');
  });

  it('renders nothing when ready', () => {
    render(<RuntimeBanner runtime={{ status: 'ready', steps: [], error: null }} />);
    expect(screen.queryByTestId('runtime-banner')).toBeNull();
  });

  it('shows a dismissible error with reassurance', () => {
    render(<RuntimeBanner runtime={{ status: 'error', steps: [], error: 'CDN unreachable' }} />);
    const banner = screen.getByTestId('runtime-banner');
    expect(banner.textContent).toContain('Compression codecs unavailable');
    expect(banner.textContent).toContain('CDN unreachable');
    expect(banner.textContent).toContain('Everything else works — the other codecs are unaffected.');
    fireEvent.click(screen.getByTestId('runtime-banner-dismiss'));
    expect(screen.queryByTestId('runtime-banner')).toBeNull();
  });
});
