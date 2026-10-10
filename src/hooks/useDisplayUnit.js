import { useEffect, useState } from 'react';
import { getDisplayUnit, setDisplayUnit, subscribeDisplayUnit } from '../utils/displayUnit';

/**
 * The global mm|in choice (`surfcad.displayUnit`). Measure, the joint
 * distance field, and sheet metal read it. The value is persisted; scripts
 * and the kernel stay millimetres.
 */
export function useDisplayUnit() {
  const [unit, setUnit] = useState(getDisplayUnit);
  useEffect(() => subscribeDisplayUnit(setUnit), []);
  return [unit, setDisplayUnit];
}
