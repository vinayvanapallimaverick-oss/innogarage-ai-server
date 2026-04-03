/**
 * Polyfill globalThis.File for Electron's embedded Node.js (< Node 20).
 *
 * Node 20 introduced File as a Web-compatible global. Electron 28 bundles
 * Node 18, which does not expose File globally. The OpenAI SDK (v6+) requires
 * globalThis.File to be defined for audio/file uploads via toFile().
 *
 * This file MUST be the first import in main.ts so the polyfill is in place
 * before any module that touches the OpenAI SDK is evaluated.
 */

// Always apply unconditionally — a conditional check may miss edge cases
// in Electron's utility process where File can be partially defined.
try {
  // Node 20+ exposes File natively via the buffer module
  const bufferModule = require('node:buffer');
  if (typeof bufferModule.File === 'function') {
    (globalThis as any).File = bufferModule.File;
  } else {
    throw new Error('buffer.File not available');
  }
} catch {
  // Fallback: build a File class on top of Blob (available since Node 18)
  try {
    const BlobCtor: typeof Blob =
      typeof Blob === 'function' ? Blob : require('buffer').Blob;

    class FilePolyfill extends BlobCtor {
      readonly name: string;
      readonly lastModified: number;

      constructor(
        fileBits: BlobPart[],
        fileName: string,
        options: BlobPropertyBag & { lastModified?: number } = {},
      ) {
        super(fileBits, options);
        this.name = fileName;
        this.lastModified = options.lastModified ?? Date.now();
      }
    }
    (globalThis as any).File = FilePolyfill;
  } catch (err) {
    console.error('[polyfills] Failed to create File polyfill:', err);
  }
}
