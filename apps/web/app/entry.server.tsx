import { PassThrough } from 'node:stream';

import type { AppLoadContext, EntryContext } from '@remix-run/node';
import { createReadableStreamFromReadable } from '@remix-run/node';
import { RemixServer } from '@remix-run/react';
import { getCoreConfig } from '@winback/config';
import { getLogger } from '@winback/logger';
import { getShopifyConfig } from '@winback/shopify';
import { isbot } from 'isbot';
import { renderToPipeableStream } from 'react-dom/server';

import { setSecurityHeaders } from '~/services/security-headers.server.js';

// =============================================================================
// BOOT-TIME CONFIG VALIDATION
//
// Force validation at module load. If env is missing or malformed, the
// process dies HERE with a ConfigError, before binding the HTTP port. This
// matches the discipline established in A2.
//
// Order matters: getCoreConfig first (validates NODE_ENV, SERVICE_NAME,
// LOG_LEVEL), then getShopifyConfig (validates Shopify keys + ENCRYPTION_KEY).
// A core-config failure should surface as a core-config error, not a Shopify
// one.
// =============================================================================
getCoreConfig();
getShopifyConfig();

const log = getLogger('web.entry');
log.info({ env: getCoreConfig().NODE_ENV }, 'web server boot');

const ABORT_DELAY = 5_000;

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext,
  _loadContext: AppLoadContext,
): Promise<Response> {
  // CSP frame-ancestors + nosniff + Referrer-Policy on every document
  // response (B3 / closes L2-H2, L2-M2). Shared between the bot and
  // browser render paths via this single call site — see the file-
  // header docstring at services/security-headers.server.ts for the
  // shop-absent strict-deny decision and the deliberate X-Frame-Options
  // omission. Runs synchronously, so the response (whether rendered by
  // the bot path, the browser path, or Remix's error UI for a thrown
  // Response) carries the headers regardless of which branch resolves.
  setSecurityHeaders(request, responseHeaders);

  return isbot(request.headers.get('user-agent') ?? '')
    ? handleBotRequest(request, responseStatusCode, responseHeaders, remixContext)
    : handleBrowserRequest(request, responseStatusCode, responseHeaders, remixContext);
}

function handleBotRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    let shellRendered = false;
    const { pipe, abort } = renderToPipeableStream(
      <RemixServer context={remixContext} url={request.url} abortDelay={ABORT_DELAY} />,
      {
        onAllReady() {
          shellRendered = true;
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);
          responseHeaders.set('Content-Type', 'text/html');
          resolve(
            new Response(stream, { headers: responseHeaders, status: responseStatusCode }),
          );
          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          if (shellRendered) log.error({ err: error }, 'render error after shell');
        },
      },
    );
    setTimeout(abort, ABORT_DELAY);
  });
}

function handleBrowserRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    let shellRendered = false;
    const { pipe, abort } = renderToPipeableStream(
      <RemixServer context={remixContext} url={request.url} abortDelay={ABORT_DELAY} />,
      {
        onShellReady() {
          shellRendered = true;
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);
          responseHeaders.set('Content-Type', 'text/html');
          resolve(
            new Response(stream, { headers: responseHeaders, status: responseStatusCode }),
          );
          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          if (shellRendered) log.error({ err: error }, 'render error after shell');
        },
      },
    );
    setTimeout(abort, ABORT_DELAY);
  });
}
