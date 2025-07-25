/**
 * Augment the Node.js module builtin types to support the v22.8+ compile cache functions
 */
import { getCompileCacheDir } from 'node:module';
import { Piscina } from 'piscina';

declare module 'node:module' {
  function getCompileCacheDir(): string | undefined;
}

export type WorkerPoolOptions = ConstructorParameters<typeof Piscina>[0];

export class WorkerPool extends Piscina {
  constructor(options: WorkerPoolOptions) {
    const piscinaOptions: WorkerPoolOptions = {
      minThreads: 1,
      idleTimeout: 1000,
      // Web containers do not support transferable objects with receiveOnMessagePort which
      // is used when the Atomics based wait loop is enable.
      atomics: process.versions.webcontainer ? 'disabled' : 'sync',
      recordTiming: false,
      ...options,
    };

    // Enable compile code caching if enabled for the main process (only exists on Node.js v22.8+).
    // Skip if running inside Bazel via a RUNFILES environment variable check. The cache does not work
    // well with Bazel's hermeticity requirements.
    const compileCacheDirectory = process.env['RUNFILES'] ? undefined : getCompileCacheDir?.();
    if (compileCacheDirectory) {
      if (typeof piscinaOptions.env === 'object') {
        piscinaOptions.env['NODE_COMPILE_CACHE'] = compileCacheDirectory;
      } else {
        // Default behavior of `env` option is to copy current process values
        piscinaOptions.env = {
          ...process.env,
          NODE_COMPILE_CACHE: compileCacheDirectory,
        };
      }
    }

    super(piscinaOptions);
  }
}
