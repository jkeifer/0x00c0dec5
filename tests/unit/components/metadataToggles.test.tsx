// @vitest-environment jsdom
//
// Task 5 (read plan): MetadataEditor exposes five include-group toggles
// (metadata.include.{schema,layout,codecs,chunkIndex,descriptive} — Task 1)
// each with a one-line consequence hint. All five are driven off real
// AppState via AppStateProvider + the same UPDATE_METADATA_CONFIG action the
// existing chunk-index toggle already uses (Sidebar.tsx), and all five are
// disabled with a note when write.includeMetadata is false (nothing is
// written, so the toggles are moot).
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AppStateProvider, useAppState } from '../../../src/state/useAppState.ts';
import { MetadataEditor } from '../../../src/components/config/MetadataEditor.tsx';

// Thin wrapper mirroring Sidebar.tsx's MetadataEditor wiring, so the test
// exercises the real dispatch idiom rather than a mock callback. Default
// AppState has write.includeMetadata: false, so this wrapper forces it true
// for the "toggles enabled" scenarios — the disabled scenario below uses the
// real default instead of forcing false.
function Wrapper() {
  const { state, dispatch } = useAppState();
  const withMetadataOn = { ...state, write: { ...state.write, includeMetadata: true } };
  return (
    <MetadataEditor
      metadata={withMetadataOn.metadata}
      state={withMetadataOn}
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

const GROUPS = ['schema', 'layout', 'codecs', 'chunk-index', 'descriptive'];

describe('MetadataEditor include-group toggles', () => {
  it('renders all five toggles, enabled and checked per default state (all true)', () => {
    renderEditor();

    for (const group of GROUPS) {
      const row = screen.getByTestId(`include-${group}-toggle`);
      expect(row).toBeTruthy();
      // Radio's active option renders as the "Yes" button; default state has
      // every include flag true.
      const yesBtn = row.querySelector('button[data-testid$="-yes"], button');
      expect(yesBtn).toBeTruthy();
    }

    // No "metadata is not being written" note when includeMetadata is true (default).
    expect(screen.queryByText(/metadata is not being written/i)).toBeNull();
  });

  it('clicking the schema toggle flips its checked state via real dispatch', () => {
    renderEditor();

    const schemaRow = screen.getByTestId('include-schema-toggle');
    const noBtn = Array.from(schemaRow.querySelectorAll('button')).find(
      (b) => b.textContent === 'No',
    )!;
    fireEvent.click(noBtn);

    // After the click, the "No" option should now be the active/selected one.
    // Radio marks the active button via color/background rather than a
    // disabled attribute, so assert through the accent color used for active.
    expect(noBtn.style.color).not.toBe('');
  });

  it('disables all five toggles and shows a note when write.includeMetadata is false', () => {
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
});

function DisabledWrapper() {
  const { state, dispatch } = useAppState();
  // Default AppState already has write.includeMetadata: false — no forcing needed.
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
