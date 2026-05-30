import { type LoaderFunctionArgs, json } from '@remix-run/node';
import { Link, useLoaderData, useSearchParams } from '@remix-run/react';
import { BlockStack, Card, Layout, Page, Text } from '@shopify/polaris';
import { SYSTEM_SCOPE_REASONS } from '@winback/contracts';
import {
  CustomerScoreRepository,
  type CustomerStateValue,
  withTenantScope,
} from '@winback/db';

import { requireAdminAuth } from '~/services/admin-auth.server.js';
import { getPrisma } from '~/services/db.server.js';
import { withRequest } from '~/services/request-context.server.js';

/**
 * Embedded landing page.
 *
 * Two responsibilities:
 *   1. Install guard via `requireAdminAuth` — verifies the session-token
 *      JWT (preferring `Authorization: Bearer` header, falling back to
 *      `?id_token=` query) when present; falls back to the legacy
 *      shop-only Merchant lookup during the coexistence window.
 *      Missing-merchant redirects route to /auth Branch A (with id_token,
 *      idempotent re-bootstrap) or Branch B (no id_token, code-grant)
 *      depending on whether a JWT was provided.
 *   2. State-band summary — six cards, one per CustomerState band, each
 *      linking through to `/customers?state=<band>`. Driven by
 *      CustomerScoreRepository.getStateBandCounts under withTenantScope.
 *
 * CRITICAL (unchanged from prior version): the withTenantScope callback
 * is `async` with explicit `await` for the Prisma call. A sync callback
 * that returns the PrismaPromise ends ALS.run BEFORE the promise
 * resolves and the Prisma extension throws TenantScopeError when its
 * query hook fires. Locked at design.md.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return withRequest(request, async () => {
    const ctx = await requireAdminAuth(request, SYSTEM_SCOPE_REASONS.web.index_lookup);

    const stateBandCounts = await withTenantScope(ctx.merchantId, async () => {
      const repo = new CustomerScoreRepository(getPrisma());
      return await repo.getStateBandCounts(ctx.merchantId);
    });

    return json({
      shop: ctx.shop,
      installedAt: ctx.installedAt.toISOString(),
      host: ctx.host,
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
