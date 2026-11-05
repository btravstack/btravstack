/** Keep later-layer precedence without reading values before policy filtering. */
export const mergeAttributeDescriptors = <Value>(
  ...layers: readonly (Readonly<Record<string, Value>> | undefined)[]
): Readonly<Record<string, Value>> => {
  const merged: Record<string, Value> = {};
  for (const layer of layers) {
    if (layer === undefined) continue;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(layer))) {
      if (descriptor.enumerable) {
        Object.defineProperty(merged, key, { ...descriptor, configurable: true });
      }
    }
  }
  return merged;
};
