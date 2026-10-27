/** Bound independent metadata operations, and drain in-flight work on failure. */
export async function revisionSteps<T>(items: T[], apply: (item: T, index: number) => Promise<void>, limit = 4): Promise<void> {
  let next = 0;
  let failure: unknown;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { await apply(items[index], index); }
      catch (error) { failed = true; failure = error; }
    }
  }));
  if (failed) throw failure;
}
