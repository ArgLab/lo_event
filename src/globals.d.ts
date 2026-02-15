// WebExtension API declarations (minimal subset used by lo-event)

declare const chrome: {
  storage?: {
    sync?: {
      get(keys: string | string[] | null, callback?: (result: Record<string, unknown>) => void): void;
      set(items: Record<string, unknown>, callback?: () => void): void;
    };
    local?: {
      get(keys: string | string[] | null, callback?: (result: Record<string, unknown>) => void): void;
      set(items: Record<string, unknown>, callback?: () => void): void;
    };
  };
  identity?: {
    getProfileUserInfo(options: { accountStatus?: string }, callback: (data: { email?: string; id?: string }) => void): void;
    // Overload without options (workaround for Chrome bug #907425)
    getProfileUserInfo(callback: (data: { email?: string; id?: string }) => void): void;
  };
  runtime?: {
    lastError?: { message?: string };
    sendMessage(message: unknown, callback?: (response?: unknown) => void): void;
    onMessage?: {
      addListener(callback: (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => void): void;
      removeListener(callback: (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => void): void;
    };
  };
};

// Firefox uses `browser` instead of `chrome`
declare const browser: typeof chrome;

// Network Information API (non-standard but widely supported)
interface Navigator {
  connection?: Record<string, unknown>;
}

// Modules without type declarations
declare module 'redux-state-sync';
