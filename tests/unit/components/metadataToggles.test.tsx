// @vitest-environment jsdom
//
// Task 5 (read plan): MetadataEditor exposes six include-group toggles
// (metadata.include.{schema,layout,codecs,chunkIndex,descriptive,endianness} —
// Task 1 / Task 9) as label + Radio only — the old per-group "hint" spoiler
// text is gone (Task 8, metadata redesign).
//
// Task 8 (metadata redesign): MetadataEditor now owns the master switch
// itself (`metadata-enabled-toggle`, dispatching UPDATE_METADATA_CONFIG
// {enabled}) rather than reading it from a Write-section toggle. Everything
// below the enable toggle (include toggles, serialization, size line) is
// disabled/dimmed when metadata.enabled is false, and the "metadata is not
// being written" Write-reference span is gone along with it.
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AppStateProvider, useAppState } from '../../../src/state/useAppState.ts';
import { MetadataEditor } from '../../../src/components/config/MetadataEditor.tsx';
import { colors } from '../../../src/theme.ts';

const GROUPS = ['schema', 'layout', 'codecs', 'chunk-index', 'descriptive', 'endianness'];

// Old per-group hint strings (deleted in Task 8 — labels only now, no spoilers).
const OLD_HINT_SNIPPETS = [
  /without this, the reader stops at/i,
  /the reader loses: nothing/i,
  /the reader assumes the host's byte order/i,
];

function Wrapper() {
  const { state, dispatch } = useAppState();
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
      onEnabledChange={(enabled) => dispatch({ type: 'UPDATE_METADATA_CONFIG', changes: { enabled } })}
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

describe('MetadataEditor enable toggle', () => {
  it('renders metadata-enabled-toggle and dispatches UPDATE_METADATA_CONFIG {enabled} on click', () => {
    renderEditor();

    // Default AppState has metadata.enabled: false.
    const yesBtn = screen.getByTestId('metadata-enabled-toggle-opt-yes') as HTMLButtonElement;
    const noBtn = screen.getByTestId('metadata-enabled-toggle-opt-no') as HTMLButtonElement;
    expect(noBtn.style.color).toBe(colors.accent);
    expect(yesBtn.style.color).not.toBe(colors.accent);

    fireEvent.click(yesBtn);

    expect(yesBtn.style.color).toBe(colors.accent);
    expect(noBtn.style.color).not.toBe(colors.accent);
  });

  it('dims/disables controls below the enable toggle when metadata.enabled is false', () => {
    renderEditor();

    // Include toggles disabled.
    for (const group of GROUPS) {
      const row = screen.getByTestId(`include-${group}-toggle`);
      const buttons = row.querySelectorAll('button');
      for (const btn of Array.from(buttons)) {
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      }
    }

    // Serialization radio disabled.
    const jsonBtn = screen.getByText('JSON') as HTMLButtonElement;
    expect(jsonBtn.disabled).toBe(true);

    // Size line shows the zero-bytes disabled state.
    expect(screen.getByTestId('metadata-serialized-size').textContent).toMatch(/Serialized: 0 bytes/);

    // The old Write-reference span is gone.
    expect(screen.queryByText(/metadata is not being written/i)).toBeNull();
  });

  it('enables controls below the enable toggle once metadata.enabled is true', () => {
    renderEditor();

    fireEvent.click(screen.getByTestId('metadata-enabled-toggle-opt-yes'));

    for (const group of GROUPS) {
      const row = screen.getByTestId(`include-${group}-toggle`);
      const buttons = row.querySelectorAll('button');
      for (const btn of Array.from(buttons)) {
        expect((btn as HTMLButtonElement).disabled).toBe(false);
      }
    }

    const jsonBtn = screen.getByText('JSON') as HTMLButtonElement;
    expect(jsonBtn.disabled).toBe(false);
  });
});

describe('MetadataEditor include-group toggles', () => {
  it('renders all six toggles as label + Radio only, with no hint text', () => {
    renderEditor();
    fireEvent.click(screen.getByTestId('metadata-enabled-toggle-opt-yes'));

    for (const group of GROUPS) {
      const row = screen.getByTestId(`include-${group}-toggle`);
      const yesBtn = row.querySelector(`button[data-testid="include-${group}-toggle-opt-yes"]`) as HTMLButtonElement;
      const noBtn = row.querySelector(`button[data-testid="include-${group}-toggle-opt-no"]`) as HTMLButtonElement;
      expect(yesBtn).toBeTruthy();
      expect(noBtn).toBeTruthy();
    }

    for (const snippet of OLD_HINT_SNIPPETS) {
      expect(screen.queryByText(snippet)).toBeNull();
    }
  });

  it('clicking the schema toggle flips its checked state via real dispatch', () => {
    renderEditor();
    fireEvent.click(screen.getByTestId('metadata-enabled-toggle-opt-yes'));

    const yesBtn = screen.getByTestId('include-schema-toggle-opt-yes') as HTMLButtonElement;
    const noBtn = screen.getByTestId('include-schema-toggle-opt-no') as HTMLButtonElement;

    fireEvent.click(noBtn);

    expect(noBtn.style.color).toBe(colors.accent);
    expect(yesBtn.style.color).not.toBe(colors.accent);
  });
});

describe('MetadataEditor custom entries', () => {
  it('renders the + Entry button before the first custom row in DOM order', () => {
    renderEditor();
    fireEvent.click(screen.getByTestId('metadata-enabled-toggle-opt-yes'));

    fireEvent.click(screen.getByText('+ Entry'));

    const addButton = screen.getByText('+ Entry');
    const firstKeyInput = screen.getByTestId('metadata-custom-key-0');

    // DOM order: addButton must precede the custom row it triggered.
    const position = addButton.compareDocumentPosition(firstKeyInput);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows an override note (not the old collision-warning testid) for a custom entry keyed "shape"', () => {
    renderEditor();
    fireEvent.click(screen.getByTestId('metadata-enabled-toggle-opt-yes'));
    // "shape" is auto-collected under the "layout" include group.
    fireEvent.click(screen.getByTestId('include-layout-toggle-opt-yes'));

    fireEvent.click(screen.getByText('+ Entry'));
    const keyInput = screen.getByTestId('metadata-custom-key-0');
    fireEvent.change(keyInput, { target: { value: 'shape' } });

    expect(screen.getByTestId('metadata-key-override-note-0')).toBeTruthy();
    expect(screen.queryByTestId('metadata-key-collision-warning-0')).toBeNull();
    expect(screen.getByTestId('metadata-key-override-note-0').textContent).toMatch(/overrides auto-collected shape/);
  });
});
