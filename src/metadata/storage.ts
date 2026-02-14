/**
 * Fetch a set of keys from storage to include with metadata
 */
export function getStorageMetadata (storage: Storage | null, keys: string[] | null = null) {
  if (!storage) {
    return null;
  }

  try {
    const items: Record<string, unknown> = {};
    // If no keys provided, get all items
    if (!keys) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)!;
        try {
          items[key] = storage.getItem(key);
        } catch (e) {
          // TODO: This should probably be communicated out-of-line, rather than
          // the same place as data.
          const err = e as Error;
          items[key] = {
            type: 'error',
            error_type: err.name || 'Unknown',
            error_message: err.message || ''
          };
        }
      }
    }
    // Otherwise, only get specified keys
    else {
      keys.forEach(key => {
        try {
          items[key] = storage.getItem(key);
        } catch (e) {
          const err = e as Error;
          items[key] = {
            type: 'error',
            error_type: err.name || 'Unknown',
            error_message: err.message || ''
          };
        }
      });
    }

    return items;
  } catch (e) {
    return null; // Return null if storage is not accessible
  }
}

export const localStorageInfo = (keys: string[] | null = null) => ({
  name: 'localStorageInfo',
  func: () => getStorageMetadata(typeof window !== 'undefined' ? window.localStorage : null, keys),
  async: false,
  static: false // Not static as storage can change
});

export const sessionStorageInfo = (keys: string[] | null = null) => ({
  name: 'sessionStorageInfo',
  func: () => getStorageMetadata(typeof window !== 'undefined' ? window.sessionStorage : null, keys),
  async: false,
  static: false
});
