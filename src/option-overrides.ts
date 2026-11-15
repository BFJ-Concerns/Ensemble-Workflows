/**
 * The author's options with a few properties settled by the harness laid
 * over them — the effective strip, the lean start, a named target's
 * resolved engine and model. A view over the author's object, not a copy:
 * a copy would drop options an author's accessor, prototype or Proxy trap
 * supplies. The overrides answer `get`, `has`, `ownKeys` and property
 * descriptors alike, so a spread or an `in` test downstream sees them as
 * own properties; an override whose value is `undefined` reads as unset.
 */
export function withOptionOverrides<T extends object>(options: T, overrides: Record<string, unknown>): T {
  // The empty target permits overrides even when the caller's object is
  // frozen. Proxy invariants must not tie the effective values to its
  // non-configurable properties.
  return new Proxy({} as T, {
    get(_target, property, receiver) {
      return typeof property === "string" && Object.hasOwn(overrides, property) ? overrides[property] : Reflect.get(options, property, receiver);
    },
    has(_target, property) {
      return (typeof property === "string" && Object.hasOwn(overrides, property)) || Reflect.has(options, property);
    },
    ownKeys() {
      return [...new Set([...Reflect.ownKeys(options), ...Object.keys(overrides)])];
    },
    getOwnPropertyDescriptor(_target, property) {
      if (typeof property === "string" && Object.hasOwn(overrides, property)) {
        return { value: overrides[property], writable: true, enumerable: true, configurable: true };
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(options, property);
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
    }
  });
}
