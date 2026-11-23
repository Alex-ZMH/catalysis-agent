// Service health can change while a conversation stays open (e.g. a restart).
// Keep it separate from login state and never reset the current conversation.
export function startServiceStatusRefresh({ refresh, document, window, intervalMs = 20000, schedule = setTimeout, cancel = clearTimeout }) {
  let stopped = false, pending = null, timer;
  const check = () => {
    if (stopped || document.hidden || pending) return pending;
    pending = Promise.resolve().then(refresh).catch(() => {}).finally(() => { pending = null; });
    return pending;
  };
  const tick = async () => {
    await check();
    if (!stopped) timer = schedule(tick, intervalMs);
  };
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
  timer = schedule(tick, intervalMs);
  return () => {
    stopped = true; cancel(timer);
    document.removeEventListener('visibilitychange', check);
    window.removeEventListener('focus', check);
  };
}
