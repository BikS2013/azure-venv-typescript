import { BlobContent } from '../types/index.js';

/**
 * Parses a `source_path@source_registry` expression and finds the matching blob.
 *
 * The expression format is: `<source_path>@<source_registry>`
 * - The `@` delimiter is split on the **last** occurrence, so source_path may contain `@`.
 * - Both parts are compared case-sensitively against blob metadata.
 *
 * @param blobs - Array of BlobContent objects (e.g., from SyncResult.blobs)
 * @param expression - Lookup expression in the format `source_path@source_registry`
 * @returns The matching BlobContent, or undefined if no match is found
 * @throws {Error} If the expression format is invalid (missing `@` delimiter)
 */
export function findBlobBySource(
  blobs: readonly BlobContent[],
  expression: string,
): BlobContent | undefined {
  const lastAtIndex = expression.lastIndexOf('@');

  if (lastAtIndex <= 0 || lastAtIndex === expression.length - 1) {
    throw new Error(
      `Invalid source expression "${expression}": expected format "source_path@source_registry"`,
    );
  }

  const sourcePath = expression.substring(0, lastAtIndex);
  const sourceRegistry = expression.substring(lastAtIndex + 1);

  return blobs.find(
    (blob) => blob.sourcePath === sourcePath && blob.sourceRegistry === sourceRegistry,
  );
}
