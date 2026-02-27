#!/usr/bin/env node
import { Command } from 'commander';
import { initAzureVenv } from '../initialize.js';
import type { AzureVenvOptions, LogLevel, SyncMode } from '../config/types.js';
import type { SyncResult } from '../types/index.js';

const program = new Command();

program
  .name('azure-venv')
  .version('0.2.0')
  .description('CLI tool for azure-venv: sync Azure Blob Storage to local filesystem');

/**
 * Print a sync result summary to stdout.
 */
function printSyncSummary(result: SyncResult): void {
  console.log('');
  console.log('=== Sync Result ===');
  console.log(`  Attempted:      ${result.attempted}`);
  console.log(`  Total blobs:    ${result.totalBlobs}`);
  console.log(`  Downloaded:     ${result.downloaded}`);
  console.log(`  Skipped:        ${result.skipped}`);
  console.log(`  Failed:         ${result.failed}`);
  console.log(`  Duration:       ${result.duration}ms`);
  console.log(`  Remote .env:    ${result.remoteEnvLoaded ? 'loaded' : 'not loaded'}`);

  if (result.failedBlobs.length > 0) {
    console.log(`  Failed blobs:`);
    for (const blob of result.failedBlobs) {
      console.log(`    - ${blob}`);
    }
  }

  const envSourceKeys = Object.keys(result.envSources);
  if (envSourceKeys.length > 0) {
    console.log(`  Env sources:    ${envSourceKeys.length} variable(s) tracked`);
  }

  console.log('');
}

/**
 * Build AzureVenvOptions from parsed CLI option values.
 */
function buildOptions(opts: Record<string, unknown>): AzureVenvOptions {
  const options: AzureVenvOptions = {};

  if (opts.rootDir !== undefined) {
    options.rootDir = opts.rootDir as string;
  }
  if (opts.logLevel !== undefined) {
    options.logLevel = opts.logLevel as LogLevel;
  }
  if (opts.failOnError === true) {
    options.failOnError = true;
  }
  if (opts.concurrency !== undefined) {
    options.concurrency = Number(opts.concurrency);
  }
  if (opts.syncMode !== undefined) {
    options.syncMode = opts.syncMode as SyncMode;
  }
  if (opts.pollInterval !== undefined) {
    options.pollInterval = Number(opts.pollInterval);
  }

  return options;
}

// ---- Subcommand: sync ----

program
  .command('sync')
  .description('Perform a one-time sync from Azure Blob Storage')
  .option('--root-dir <path>', 'Application root directory')
  .option('--log-level <level>', 'Log level (debug, info, warn, error)')
  .option('--fail-on-error', 'Exit with error on any Azure failure')
  .option('--concurrency <number>', 'Max parallel blob downloads')
  .option('--sync-mode <mode>', 'Sync mode (full, incremental)')
  .action(async (opts: Record<string, unknown>) => {
    try {
      const options = buildOptions(opts);
      const result = await initAzureVenv(options);

      printSyncSummary(result);

      if (result.failed > 0 && options.failOnError) {
        process.exit(1);
      }

      process.exit(0);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

// ---- Subcommand: watch ----

program
  .command('watch')
  .description('Start watching for blob changes after initial sync')
  .option('--root-dir <path>', 'Application root directory')
  .option('--log-level <level>', 'Log level (debug, info, warn, error)')
  .option('--fail-on-error', 'Exit with error on any Azure failure')
  .option('--concurrency <number>', 'Max parallel blob downloads')
  .option('--sync-mode <mode>', 'Sync mode (full, incremental)')
  .option('--poll-interval <ms>', 'Polling interval in milliseconds')
  .action(async (opts: Record<string, unknown>) => {
    try {
      const options = buildOptions(opts);
      options.watchEnabled = true;

      if (opts.pollInterval !== undefined) {
        options.pollInterval = Number(opts.pollInterval);
      }

      // Dynamically import watch module (may not exist yet)
      const { watchAzureVenv } = await import('../watch/watcher.js');

      const watchResult = await watchAzureVenv(options);

      printSyncSummary(watchResult.initialSync);
      console.log('Watching for changes... (press Ctrl+C to stop)');

      // Keep the event loop alive so the unref'd watcher interval doesn't let Node exit
      process.stdin.resume();

      // Wait for SIGINT/SIGTERM
      const shutdown = (exitCode: number): void => {
        console.log('\nStopping watcher...');
        watchResult.stop();
        process.stdin.pause();
        process.exit(exitCode);
      };

      process.on('SIGINT', () => {
        shutdown(130);
      });

      process.on('SIGTERM', () => {
        shutdown(0);
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program.parse();
