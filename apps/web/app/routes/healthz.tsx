/**
 * Liveness probe. Returns 200 as long as the process is responding.
 * Does NOT touch the database or any downstream — use /readyz for that.
 */
export function loader() {
  return new Response('ok', {
    status: 200,
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
  });
}
