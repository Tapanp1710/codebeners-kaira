"use client";

import { useEffect, useState } from "react";

/**
 * Returns `value` only after it has stopped changing for `ms` milliseconds (default 300).
 * Used by the customers, invoices and receivables list pages so typing in the search box does not
 * issue a backend query (and a new query-cache entry) per keystroke. Each change resets the timer.
 */
export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
