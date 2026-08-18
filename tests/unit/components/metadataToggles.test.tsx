// @vitest-environment jsdom
//
// Task 5 (read plan): MetadataEditor exposes five include-group toggles
// (metadata.include.{schema,layout,codecs,chunkIndex,descriptive} — Task 1)
// each with a one-line consequence hint. All five are driven off real
// AppState via AppStateProvider + the same UPDATE_METADATA_CONFIG action the
// existing chunk-index toggle already uses (Sidebar.tsx), and all five are
// disabled with a note when metadata.enabled is false (nothing is
// written, so the toggles are moot).
//
// Task 9 (codec-curation plan): a 6th toggle, `include-endianness-toggle`,
// wired to metadata.include.endianness the same way. Its failure mode is
// unique — off doesn't fail a read step, it silently produces wrong values
// on big-endian files (see the mini-lesson in MetadataEditor.tsx's hint).
//
// Metadata redesign Task 1 (controller ruling R1): the master switch moved
// from write.includeMetadata to metadata.enabled — MetadataEditor's
// `metadataDisabled` now reads `!state.metadata.enabled`.
import { describe, it, expect } from 'vitest';
import { useEffect } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { AppStateProvider, useAppState } from '../../../src/state/useAppState.ts';
import { MetadataEditor } from '../../../src/components/config/MetadataEditor.tsx';
import { colors } from '../../../src/theme.ts';

const ALL_INCLUDE = { schema: true, layout: true, codecs: true, chunkIndex: true, descriptive: true, endianness: true };

// Thin wrapper mirroring Sidebar.tsx's MetadataEditor wiring, so the test
// exercises the real dispatch idiom rather than a mock callback. Default
// AppState has metadata.enabled: false and every include group false, so
// this wrapper dispatches once on mount to seed enabled + all include groups
// true for the "toggles enabled" scenarios (a real UPDATE_METADATA_CONFIG
// dispatch, not a forced render prop, so subsequent toggle clicks compose
// correctly against real state) — the disabled scenario below uses the real
// default instead of seeding anything.
function Wrapper() {
  const { state, dispatch } = useAppState();
  useEffect(() => {
    dispatch({ type: 'UPDATE_METADATA_CONFIG', changes: { enabled: true, include: { ...ALL_INCLUDE } } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <MetadataEditor
      metadata={state.metadata}
      state={state}
      onSerializationChange={(serialization) =>
        dispatch({ type: 'UPDATE_METADATA_CONFIG', changes: { serialization } })
      }
      onAddEntry={() => dispatch({ type: 'ADD_METADATA_ENTRY' })}
      onRemoveEntry={(index) => dispatch({ type: 'REMOVE_METADATA_ENTRY', index })}
      onUpdateEntry={(index, key, value) =>
        dispatch({ type: 'UPDATE_METADATA_ENTRY', index, key, value })
      }
      onIncludeChange={(key, value) =>
        dispatch({
          type: 'UPDATE_METADATA_CONFIG',
          changes: { include: { ...state.metadata.include, [key]: value } },
        })
      }
    />
  );
}

function renderEditor() {
  return render(
    <AppStateProvider>
      <Wrapper />
    </AppStateProvider>,
  );
}

const GROUPS = ['schema', 'layout', 'codecs', 'chunk-index', 'descriptive', 'endianness'];

describe('MetadataEditor include-group toggles', () => {
  it('renders all five toggles, enabled and checked per default state (all true)', () => {
    renderEditor();

    for (const group of GROUPS) {
      const row = screen.getByTestId(`include-${group}-toggle`);
      const yesBtn = row.querySelector(`button[data-testid="include-${group}-toggle-opt-yes"]`) as HTMLButtonElement;
      const noBtn = row.querySelector(`button[data-testid="include-${group}-toggle-opt-no"]`) as HTMLButtonElement;
      expect(yesBtn).toBeTruthy();
      expect(noBtn).toBeTruthy();

      // Wrapper seeds every include flag true on mount, so "Yes" is active:
      // its color is the accent color, and it's visually distinct from "No".
      expect(yesBtn.style.color).toBe(colors.accent);
      expect(noBtn.style.color).not.toBe(colors.accent);

      // Both options are enabled (metadata.enabled seeded true above).
      expect(yesBtn.disabled).toBe(false);
      expect(noBtn.disabled).toBe(false);
    }

    // No "metadata is not being written" note when metadata.enabled is true.
    expect(screen.queryByText(/metadata is not being written/i)).toBeNull();
  });

  it('clicking the schema toggle flips its checked state via real dispatch', () => {
    renderEditor();

    const yesBtn = screen.getByTestId('include-schema-toggle-opt-yes') as HTMLButtonElement;
    const noBtn = screen.getByTestId('include-schema-toggle-opt-no') as HTMLButtonElement;

    // Before the click, "Yes" is active (Wrapper seeded schema: true on mount).
    expect(yesBtn.style.color).toBe(colors.accent);
    expect(noBtn.style.color).not.toBe(colors.accent);

    fireEvent.click(noBtn);

    // After the click, "No" must be the active one and "Yes" must not be —
    // this fails if onIncludeChange/dispatch is a no-op.
    expect(noBtn.style.color).toBe(colors.accent);
    expect(yesBtn.style.color).not.toBe(colors.accent);
  });

  it('disables all five toggles and shows a note when metadata.enabled is false', () => {
    render(
      <AppStateProvider>
        <DisabledWrapper />
      </AppStateProvider>,
    );

    for (const group of GROUPS) {
      const row = screen.getByTestId(`include-${group}-toggle`);
      const buttons = row.querySelectorAll('button');
      for (const btn of Array.from(buttons)) {
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      }
    }

    expect(screen.getByText(/metadata is not being written/i)).toBeTruthy();
  });

  it('endianness toggle hint states the silent-corruption lesson', () => {
    renderEditor();

    const row = screen.getByTestId('include-endianness-toggle');
    expect(row.textContent).toMatch(
      /reader assumes the host's byte order.*reads may silently succeed with wrong values/i,
    );
  });
});

function DisabledWrapper() {
  const { state, dispatch } = useAppState();
  // Default AppState already has metadata.enabled: false — no seeding needed.
  return (
    <MetadataEditor
      metadata={state.metadata}
      state={state}
      onSerializationChange={(serialization) =>
        dispatch({ type: 'UPDATE_METADATA_CONFIG', changes: { serialization } })
      }
      onAddEntry={() => dispatch({ type: 'ADD_METADATA_ENTRY' })}
      onRemoveEntry={(index) => dispatch({ type: 'REMOVE_METADATA_ENTRY', index })}
      onUpdateEntry={(index, key, value) =>
        dispatch({ type: 'UPDATE_METADATA_ENTRY', index, key, value })
      }
      onIncludeChange={(key, value) =>
        dispatch({
          type: 'UPDATE_METADATA_CONFIG',
          changes: { include: { ...state.metadata.include, [key]: value } },
        })
      }
    />
  );
}
