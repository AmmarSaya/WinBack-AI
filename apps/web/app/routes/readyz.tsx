import { getLogger } from '@winback/logger';
import { withSystemScope } from '@winback/db';

import { getPrisma } from '~/services/db.server.js';

const log = getLogger('web.readyz');

/**
 * Readiness probe. Returns 200 only if every critical dependency is
 * reachable. Failure → 503 (load balancer should stop sending traffic).
 *
 * The Prisma probe runs in `withSystemScope` because the readyz endpoint
 * has no tenant context — and the extension would otherwise reject the
 * query for lack of scope.
 *
 * Add more checks (Redis, etc.) as those subsystems land.
 */
export async function loader() {
  try {
    await withSystemScope('healthcheck.readyz', async () => {
      await getPrisma().$queryRaw`SELECT 1`;
    });
    return new Response('ok', {
      status: 200,
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    log.error({ err }, 'readiness probe failed');
    return new Response('not ready', {
      status: 503,
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
    });
  }
}
