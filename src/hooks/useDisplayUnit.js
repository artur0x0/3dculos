import { useEffect, useState } from 'react';
import { getDisplayUnit, setDisplayUnit, subscribeDisplayUnit } from '../utils/displayUnit';

/**
 * The global mm|in choice (`surfcad.displayUnit`). Measure is the only
 * reader so far. A later pass can call this from every length field.
 */
export function useDisplayUnit() {
  const [unit, setUnit] = useState(getDisplayUnit);
  useEffect(() => subscribeDisplayUnit(setUnit), []);
  return [unit, setDisplayUnit];
}
