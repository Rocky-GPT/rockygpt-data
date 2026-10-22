/**
 * Runs at most `concurrency` of the given tasks at once, in the order they were queued.
 *
 * Stands in for p-limit where the code is part of the package build: p-limit is ESM-only, and the
 * build emits CommonJS, so src/ (catalog policies, office sections) cannot reach it through here.
 */
export type Limit = <T>(task: () => Promise<T>) => Promise<T>;

export function limit(concurrency: number): Limit {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError('Expected a positive integer concurrency');
  }
  const waiting: Array<() => void> = [];
  let active = 0;
  const next = () => {
    if (active < concurrency && waiting.length) waiting.shift()!();
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      waiting.push(() => {
        active += 1;
        task().then(resolve, reject).finally(() => {
          active -= 1;
          next();
        });
      });
      next();
    });
}
