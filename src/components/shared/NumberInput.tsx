import { useState } from 'react';

type NumberInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type'
> & {
  value: number;
  /** Called with each parseable value as the user types. Unparseable
   * intermediate text ('', '-', '1e') commits nothing — the box keeps
   * showing it so typing isn't fought (no coerced 0 appearing under the
   * cursor), and blur re-syncs the display to the last committed value. */
  onValue: (n: number) => void;
  /** Commit only on blur/Enter instead of per keystroke. For inputs whose
   * commit triggers a full pipeline recompute (shape, chunk shape): typing
   * "3600" must not fire computes at 3, 36, and 360 on the way — the
   * intermediate values are never what the user meant, and a large one can
   * hang the worker mid-keystroke. */
  commitOnBlur?: boolean;
};

export function NumberInput({ value, onValue, commitOnBlur, ...rest }: NumberInputProps) {
  // null = mirror the `value` prop; a string = in-progress text while editing
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (text: string) => {
    const n = parseFloat(text);
    if (!Number.isNaN(n)) onValue(n);
  };
  return (
    <input
      {...rest}
      type="number"
      value={draft ?? String(value)}
      onChange={(e) => {
        setDraft(e.target.value);
        if (!commitOnBlur) commit(e.target.value);
      }}
      onBlur={(e) => {
        if (commitOnBlur) commit(e.target.value);
        setDraft(null);
      }}
      onKeyDown={
        commitOnBlur
          ? (e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }
          : rest.onKeyDown
      }
    />
  );
}
