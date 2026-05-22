import { type LoaderFunctionArgs, json, redirect } from '@remix-run/node';
import { Link, useLoaderData, useSearchParams } from '@remix-run/react';
import { BlockStack, Card, Layout, Page, Text } from '@shopify/polaris';
import { SYSTEM_SCOPE_REASONS } from '@winback/contracts';
import {
  CustomerScoreRepository,
  type CustomerStateValue,
  withSystemScope,
  withTenantScope,
} from '@winback/db';
import { getLogger } from '@winback/logger';
import { isValidShopDomain } from '@winback/shopify';

import { getPrisma } from '~/services/db.server.js';
import { withRequest } from '~/services/request-context.server.js';

const log = getLogger('web.index');

/**
 * Embedded landing page.
 *
 * Two responsibilities:
 *   1. Install guard — confirm a Merchant row exists for the shop; redirect
 *      to /auth otherwise.  Pre-tenant lookup uses withSystemScope.
 *   2. State-band summary — six cards, one per CustomerState band, each
 *      linking through to `/customers?state=<band>`.  Driven by
 *      CustomerScoreRepository.getStateBandCounts under withTenantScope.
 *
 * CRITICAL (unchanged from prior version): both scope callbacks are
 * `async` with explicit `await` for the Prisma call.  A sync callback
 * that returns the PrismaPromise ends ALS.run BEFORE the promise
 * resolves and the Prisma extension throws TenantScopeError when its
 * query hook fires.  Locked at design.md.
 *
 * History: this loader used to return only `{ shop, installedAt, host }`
 * and the body was a 2×2 grid of empty-state cards naming the unlocking
 * epic.  Epic E session 2 landed the data pipe end-to-end; the empty
 * cards are now real state-band counts.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return withRequest(request, async () => {
    const url = new URL(request.url);
    const shop = url.searchParams.get('shop');
    const host = url.searchParams.get('host') ?? '';

    if (shop === null || !isValidShopDomain(shop)) {
      // `throw` (not `return`) so Remix routes this through the error
      // boundary instead of attempting to render the default component
      // with `undefined` loader data. The component's `data.stateBandCounts`
      // access would throw a less-helpful TypeError under SSR. Hit in
      // production by Render's `HEAD /` health probe (no query params).
      throw new Response('Missing shop', { status: 400 });
    }

    const merchant = await withSystemScope(SYSTEM_SCOPE_REASONS.web.index_lookup, async () => {
      return await getPrisma().merchant.findUnique({
        where: { shop },
        select: { id: true, shop: true, installedAt: true },
      });
    });

    if (merchant === null) {
      log.info({ shop }, 'index: shop not installed, redirecting to /auth');
      return redirect(`/auth?shop=${encodeURIComponent(shop)}`);
    }

    const stateBandCounts = await withTenantScope(merchant.id, async () => {
      const repo = new CustomerScoreRepository(getPrisma());
      return await repo.getStateBandCounts(merchant.id);
    });

    return json({
      shop: merchant.shop,
      installedAt: merchant.installedAt.toISOString(),
      host,
      stateBandCounts,
    });
  });
}

const BAND_ORDER: readonly CustomerStateValue[] = [
  'active',
  'warm',
  'at_risk',
  'dormant',
  'lost',
  'insufficient_data',
] as const;

const BAND_COPY: Record<CustomerStateValue, { heading: string; description: string }> = {
  active: {
    heading: 'Active',
    description: 'Bought within the last 30 days.',
  },
  warm: {
    heading: 'Warm',
    description: 'Last order 30–90 days ago.',
  },
  at_risk: {
    heading: 'At risk',
    description: 'Last order 90–180 days ago — prime winback targets.',
  },
  dormant: {
    heading: 'Dormant',
    description: 'Last order 180–365 days ago.',
  },
  lost: {
    heading: 'Lost',
    description: 'No order in over a year.',
  },
  insufficient_data: {
    heading: 'Insufficient data',
    description: 'Fewer than 5 paying customers — scoring activates automatically.',
  },
};

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();

  // Preserve `shop` + `host` across navigation — embedded Shopify apps
  // need both in the query string on every route.
  const queryString = (() => {
    const next = new URLSearchParams();
    const shop = searchParams.get('shop');
    const host = searchParams.get('host');
    if (shop !== null) next.set('shop', shop);
    if (host !== null) next.set('host', host);
    return next;
  })();

  return (
    <Page title="AI Customer Winback">
      <Layout>
        {BAND_ORDER.map((band) => {
          const linkQuery = new URLSearchParams(queryString);
          linkQuery.set('state', band);
          return (
            <Layout.Section key={band} variant="oneThird">
              <Link
                to={`/customers?${linkQuery.toString()}`}
                style={{ textDecoration: 'none', color: 'inherit' }}
                prefetch="intent"
              >
                <Card>
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">
                      {BAND_COPY[band].heading}
                    </Text>
                    <Text as="p" variant="heading2xl">
                      {(data.stateBandCounts?.[band] ?? 0).toLocaleString()}
                    </Text>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      {BAND_COPY[band].description}
                    </Text>
                  </BlockStack>
                </Card>
              </Link>
            </Layout.Section>
          );
        })}
      </Layout>
    </Page>
  );
}
