"use client";

import * as React from "react";

/**
 * Debounce a fast-changing value. Used on the leads-list search
 * input so the API isn't hit on every keystroke.
 *
 * Returns a new value only after the input has been stable for
 * `delayMs`. Resetting the input (clear) flushes immediately —
 * the timer fires only on the trailing edge of a sequence.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);

  React.useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
