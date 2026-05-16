import { type LoaderFunctionArgs, json, redirect } from '@remix-run/node';
import { BlockStack, Card, Layout, Page, Text } from '@shopify/polaris';
import { SYSTEM_SCOPE_REASONS } from '@winback/contracts';
import { withSystemScope } from '@winback/db';
import { getLogger } from '@winback/logger';
import { isValidShopDomain } from '@winback/shopify';

import { getPrisma } from '~/services/db.server.js';
import { withRequest } from '~/services/request-context.server.js';

const log = getLogger('web.index');

/**
 * Embedded landing page. The loader's job is the install-proof: confirm
 * a Merchant row exists for the shop, redirect to /auth if not.
 *
 * The body is a 2×2 grid of honest empty-state cards per design.md.
 * Each card names the Epic that will fill it with real data — so anyone
 * reading the rendered page (or this file) can trace from "this card is
 * empty" to "this is the backend work that unblocks it."
 *
 * No numbers, no charts, no fake "$0". Real merchant-facing metrics
 * arrive at Epic G+/H1 — at that point swap the BlockStack inside each
 * card for a real-data block. The grid structure and card headings stay.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return withRequest(request, async () => {
    const url = new URL(request.url);
    const shop = url.searchParams.get('shop');
    const host = url.searchParams.get('host') ?? '';

    if (shop === null || !isValidShopDomain(shop)) {
      return new Response('Missing shop', { status: 400 });
    }

    // Pre-tenant: we look up by shop without a tenant scope. Reason
    // renamed from `web.index.lookup` (two dots — latent runtime bug)
    // to `web.index_lookup` (one dot, registry-valid) in step 2.
    //
    // CRITICAL: the callback MUST be async + the Prisma call MUST be
    // awaited INSIDE the callback. A sync callback that returns the
    // PrismaPromise (`() => prisma.x.findUnique(...)`) ends ALS.run
    // BEFORE the promise resolves, so by the time the Prisma extension
    // fires its query hook and reads getTenantScope(), the scope is
    // already gone and the hook throws TenantScopeError. The async +
    // await pattern keeps the run() open across the await, so the
    // extension's hook runs inside the active scope.
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

    return json({ shop: merchant.shop, installedAt: merchant.installedAt.toISOString(), host });
  });
}

/**
 * Renders the 2×2 empty-card dashboard. Loader data is intentionally NOT
 * consumed here — the loader's value is the install guard (the redirect
 * to /auth if Merchant row is missing). When real metrics arrive at
 * Epic H1, the loader will additionally read aggregates and this
 * component will consume them via useLoaderData.
 */
export default function Index() {
  return (
    <Page title="AI Customer Winback">
      <Layout>
        <Layout.Section variant="oneHalf">
          <EmptyCard
            heading="Revenue Recovered"
            unlocks="Epic H1 (attribution + rollup tables)"
          />
        </Layout.Section>
        <Layout.Section variant="oneHalf">
          <EmptyCard
            heading="Customers Won Back"
            unlocks="Epic H1 (attribution aggregates)"
          />
        </Layout.Section>
        <Layout.Section variant="oneHalf">
          <EmptyCard
            heading="Active Campaigns"
            unlocks="Epic G (campaigns + messaging)"
          />
        </Layout.Section>
        <Layout.Section variant="oneHalf">
          <EmptyCard
            heading="At-Risk Customers"
            unlocks="Epic E (RFM + churn scoring)"
          />
        </Layout.Section>
      </Layout>
    </Page>
  );
}

/**
 * Empty-state card used for every dashboard metric until its backend
 * lands. `unlocks` names the epic — explicit so readers don't have to
 * grep design.md to find out when the card becomes real.
 */
function EmptyCard({ heading, unlocks }: { heading: string; unlocks: string }) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="h3" variant="headingMd">
          {heading}
        </Text>
        <Text as="p" variant="bodyMd" tone="subdued">
          Available when {unlocks} ships.
        </Text>
      </BlockStack>
    </Card>
  );
}
