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
};

export function NumberInput({ value, onValue, ...rest }: NumberInputProps) {
  // null = mirror the `value` prop; a string = in-progress text while editing
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      {...rest}
      type="number"
      value={draft ?? String(value)}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = parseFloat(e.target.value);
        if (!Number.isNaN(n)) onValue(n);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}
