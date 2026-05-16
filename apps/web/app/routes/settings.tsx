import { type LoaderFunctionArgs, json, redirect } from '@remix-run/node';
import { useLoaderData } from '@remix-run/react';
import { BlockStack, Card, InlineStack, Page, Text } from '@shopify/polaris';
import { SYSTEM_SCOPE_REASONS } from '@winback/contracts';
import { withSystemScope, withTenantScope } from '@winback/db';
import { getLogger } from '@winback/logger';
import { isValidShopDomain } from '@winback/shopify';

import { getPrisma } from '~/services/db.server.js';
import { withRequest } from '~/services/request-context.server.js';

const log = getLogger('web.settings');

/**
 * Read-only settings view. Reads MerchantSettings (created at install)
 * inside the tenant scope and renders each field with its current value.
 * Edit support lands at M10 — until then, operators change values via
 * direct DB update or a future admin API.
 *
 * Two-stage scope: first a system-scope lookup of the Merchant row by
 * shop (same pattern as /_index — pre-tenant because we only have the
 * shop in the query string, not a merchantId), then withTenantScope
 * around the MerchantSettings read so the Prisma extension auto-injects
 * the merchantId filter.
 *
 * CRITICAL: both scope wrappers use async callbacks with explicit await,
 * matching the pattern documented in design.md and the comment in
 * _index.tsx. The sync-callback variant breaks ALS propagation across
 * Prisma's deferred query hook.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return withRequest(request, async () => {
    const url = new URL(request.url);
    const shop = url.searchParams.get('shop');

    if (shop === null || !isValidShopDomain(shop)) {
      return new Response('Missing shop', { status: 400 });
    }

    const merchant = await withSystemScope(
      SYSTEM_SCOPE_REASONS.web.index_lookup,
      async () => {
        return await getPrisma().merchant.findUnique({
          where: { shop },
          select: { id: true },
        });
      },
    );

    if (merchant === null) {
      log.info({ shop }, 'settings: shop not installed, redirecting to /auth');
      return redirect(`/auth?shop=${encodeURIComponent(shop)}`);
    }

    const settings = await withTenantScope(merchant.id, async () => {
      return await getPrisma().merchantSettings.findUnique({
        where: { merchantId: merchant.id },
        select: {
          attributionDirectWindowDays: true,
          attributionAssistedWindowDays: true,
          sendTimeStartHour: true,
          sendTimeEndHour: true,
          monthlyAiSpendCapCents: true,
          monthlySendsCap: true,
        },
      });
    });

    if (settings === null) {
      // Shouldn't happen — install creates MerchantSettings as part of
      // the same transaction. Log and surface a generic message rather
      // than crash; M10 hardening can add automatic re-creation.
      log.warn({ merchantId: merchant.id }, 'settings: MerchantSettings row missing');
      return new Response('Settings not found', { status: 500 });
    }

    // BigInt is not JSON-serializable by default — coerce to string at
    // the boundary. The receiving component parses back if it needs the
    // numeric value, but for display "50000 cents → $500.00" is fine.
    return json({
      attributionDirectWindowDays: settings.attributionDirectWindowDays,
      attributionAssistedWindowDays: settings.attributionAssistedWindowDays,
      sendTimeStartHour: settings.sendTimeStartHour,
      sendTimeEndHour: settings.sendTimeEndHour,
      monthlyAiSpendCapCents: settings.monthlyAiSpendCapCents.toString(),
      monthlySendsCap: settings.monthlySendsCap,
    });
  });
}

export default function Settings() {
  const s = useLoaderData<typeof loader>();
  return (
    <Page title="Settings">
      <Card>
        <BlockStack gap="400">
          <SettingRow
            label="Attribution window — direct"
            value={`${s.attributionDirectWindowDays} days`}
          />
          <SettingRow
            label="Attribution window — assisted"
            value={`${s.attributionAssistedWindowDays} days`}
          />
          <SettingRow
            label="Send time window"
            value={`${s.sendTimeStartHour}:00 – ${s.sendTimeEndHour}:00 (merchant local time)`}
          />
          <SettingRow
            label="Monthly AI spend cap"
            value={`$${(BigInt(s.monthlyAiSpendCapCents) / 100n).toString()}`}
          />
          <SettingRow
            label="Monthly sends cap"
            value={`${s.monthlySendsCap.toLocaleString()} messages`}
          />
          <Text as="p" variant="bodySm" tone="subdued">
            Edit support arrives at M10. For now, contact support to change a value.
          </Text>
        </BlockStack>
      </Card>
    </Page>
  );
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <InlineStack align="space-between" blockAlign="center">
      <Text as="span" variant="bodyMd">
        {label}
      </Text>
      <Text as="span" variant="bodyMd" fontWeight="semibold">
        {value}
      </Text>
    </InlineStack>
  );
}
