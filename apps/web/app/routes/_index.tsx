import { type LoaderFunctionArgs, json, redirect } from '@remix-run/node';
import { useLoaderData } from '@remix-run/react';
import { Card, Layout, Page, Text } from '@shopify/polaris';
import { withSystemScope } from '@winback/db';
import { getLogger } from '@winback/logger';
import { isValidShopDomain } from '@winback/shopify';

import { getPrisma } from '~/services/db.server.js';
import { withRequest } from '~/services/request-context.server.js';

const log = getLogger('web.index');

/**
 * Minimal embedded landing page. C2 ships just enough to prove the OAuth
 * round-trip works end to end; the real merchant dashboard (revenue
 * recovered, customers revived, ROI metrics) lands in H3.
 *
 * If the merchant isn't installed (no Merchant row for the shop), we
 * redirect back to `/auth?shop=...` rather than crash. This handles direct
 * visits to `/` without an install having occurred.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return withRequest(request, async () => {
    const url = new URL(request.url);
    const shop = url.searchParams.get('shop');
    const host = url.searchParams.get('host') ?? '';

    if (shop === null || !isValidShopDomain(shop)) {
      return new Response('Missing shop', { status: 400 });
    }

    // Pre-tenant: we look up by shop without a tenant scope.
    const merchant = await withSystemScope('web.index.lookup', () =>
      getPrisma().merchant.findUnique({
        where: { shop },
        select: { id: true, shop: true, installedAt: true },
      }),
    );

    if (merchant === null) {
      log.info({ shop }, 'index: shop not installed, redirecting to /auth');
      return redirect(`/auth?shop=${encodeURIComponent(shop)}`);
    }

    return json({ shop: merchant.shop, installedAt: merchant.installedAt.toISOString(), host });
  });
}

export default function Index() {
  const { shop, installedAt } = useLoaderData<typeof loader>();
  return (
    <Page title="AI Customer Winback">
      <Layout>
        <Layout.Section>
          <Card>
            <Text as="h2" variant="headingMd">
              Installed
            </Text>
            <Text as="p">
              Shop: <code>{shop}</code>
            </Text>
            <Text as="p">
              Installed at: <code>{installedAt}</code>
            </Text>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
