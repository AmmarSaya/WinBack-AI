import { randomUUID } from 'node:crypto';

import { type LogContext, runWithLogContext } from '@winback/logger';

/**
 * Wraps a Remix loader/action body in a log context. Every record inside the
 * callback automatically carries `requestId` (and `merchantId`/`shopifyTopic`
 * if passed in extras).
 *
 * Use at the top of every loader/action that touches the platform:
 *
 *     export async function loader({ request }: LoaderFunctionArgs) {
 *       return withRequest(request, async () => {
 *         // ... handler body
 *       });
 *     }
 *
 * The request ID is taken from the inbound `x-request-id` header if
 * present (set by a load balancer or upstream proxy), otherwise generated.
 */
export function withRequest<T>(
  request: Request,
  fn: () => Promise<T>,
  extras: Omit<LogContext, 'requestId'> = {},
): Promise<T> {
  const incoming = request.headers.get('x-request-id');
  const requestId = incoming !== null && incoming.length > 0 ? incoming : randomUUID();
  return runWithLogContext({ requestId, ...extras }, fn);
}
