import { PassThrough } from 'node:stream';

import type { AppLoadContext, EntryContext } from '@remix-run/node';
import { createReadableStreamFromReadable } from '@remix-run/node';
import { RemixServer } from '@remix-run/react';
import { getCoreConfig } from '@winback/config';
import { getLogger } from '@winback/logger';
import { getShopifyConfig } from '@winback/shopify';
import { isbot } from 'isbot';
import { renderToPipeableStream } from 'react-dom/server';

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
          reject(error as Error);
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
          reject(error as Error);
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
