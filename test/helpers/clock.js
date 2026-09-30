// A controllable clock: sleep() advances time instantly and records the wait.
export function fakeClock(start = Date.parse('2026-09-30T17:04:00Z')) {
  let t = start;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}
