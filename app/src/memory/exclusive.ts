// Runs jobs one at a time, in the order they were queued. Memory decisions
// load models, which takes seconds on a Pi; two overlapping loads could leave
// two models resident, which is the OOM this module exists to prevent.
let tail: Promise<unknown> = Promise.resolve();

export const exclusive = <T>(job: () => Promise<T>): Promise<T> => {
  const run = tail.then(job);
  // A failed job must not block the ones queued after it.
  tail = run.catch(() => undefined);
  return run;
};
