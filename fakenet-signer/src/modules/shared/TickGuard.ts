/**
 * Deadline after which {@link runTickWithGuardRelease} releases a loop's
 * re-entrancy guard. Matches the signet write timeout: past it the tick is
 * either wedged or long enough that a fresh discovery pass is worth more
 * than strict one-at-a-time ticking.
 */
export const DEFAULT_TICK_GUARD_RELEASE_MS = 120_000;

/**
 * Run one loop tick under a guard-release deadline: resolves when `tick`
 * settles or after `releaseAfterMs`, whichever comes first, so a hung await
 * inside a tick can never hold its loop's re-entrancy flag forever (the
 * failure reads as an idle loop: no error, no log, the interval fires and
 * returns on the flag every time). On a deadline release the tick itself
 * keeps running and the release is logged, so a hang is visible instead of
 * silent. Callers must tolerate a fresh tick overlapping the released one:
 * discovery is idempotent here and every signet write is serialized
 * independently, and this repo prefers duplicate processing over a missed
 * event.
 *
 * @param label - Name of the tick, printed in the release warning.
 * @param releaseAfterMs - Deadline after which the guard is released.
 * @param tick - The tick body to run.
 * @returns Resolves when the tick settles or the deadline passes.
 */
export async function runTickWithGuardRelease(
  label: string,
  releaseAfterMs: number,
  tick: () => Promise<void>
): Promise<void> {
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      tick(),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(() => {
          console.warn(
            `${label}: tick still running after ${String(
              releaseAfterMs / 1000
            )}s — releasing the loop guard (the tick keeps running)`
          );
          resolve();
        }, releaseAfterMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
