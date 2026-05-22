import { type LoaderFunctionArgs, json, redirect } from '@remix-run/node';
import { Link, useLoaderData, useSearchParams } from '@remix-run/react';
import {
  Badge,
  BlockStack,
  Button,
  Card,
  ChoiceList,
  EmptyState,
  IndexTable,
  InlineStack,
  Page,
  Text,
  useIndexResourceState,
} from '@shopify/polaris';
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

const log = getLogger('web.customers');

const PAGE_SIZE = 50;

const ALL_STATES: readonly CustomerStateValue[] = [
  'active',
  'warm',
  'at_risk',
  'dormant',
  'lost',
  'insufficient_data',
] as const;

/**
 * `/customers` — paginated list of CustomerScore + Customer rows.
 *
 * URL state surface (all bookmarkable):
 *   - `?shop`              — required, embedded app convention
 *   - `?host`              — App Bridge handle, preserved across navigation
 *   - `?state=a,b,c`       — comma-separated CustomerState filter; empty / absent = no filter
 *   - `?cursor=<id>`       — opaque cursor (= prior page's last row's CustomerScore.id)
 *
 * Loader pattern mirrors `/settings`:
 *   1. system-scope Merchant lookup (we only have `shop` at this point)
 *   2. tenant-scope CustomerScoreRepository.listWithCustomer call
 * Both wrappers use async callbacks with explicit await — see design.md
 * + the ALS comment in `_index.tsx`.
 *
 * Soft-deleted customers are excluded by the repository's defensive
 * `customer.deletedAt: null` filter (Epic E UI data-layer batch).
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return withRequest(request, async () => {
    const url = new URL(request.url);
    const shop = url.searchParams.get('shop');
    const host = url.searchParams.get('host') ?? '';

    if (shop === null || !isValidShopDomain(shop)) {
      return new Response('Missing shop', { status: 400 });
    }

    const merchant = await withSystemScope(
      SYSTEM_SCOPE_REASONS.web.customers_lookup,
      async () => {
        return await getPrisma().merchant.findUnique({
          where: { shop },
          select: { id: true },
        });
      },
    );

    if (merchant === null) {
      log.info({ shop }, 'customers: shop not installed, redirecting to /auth');
      return redirect(`/auth?shop=${encodeURIComponent(shop)}`);
    }

    const filterStates = parseFilterStates(url.searchParams.get('state'));
    const cursor = url.searchParams.get('cursor');

    const result = await withTenantScope(merchant.id, async () => {
      const repo = new CustomerScoreRepository(getPrisma());
      return await repo.listWithCustomer({
        merchantId: merchant.id,
        cursor,
        limit: PAGE_SIZE,
        ...(filterStates.length > 0 && { filterStates }),
      });
    });

    // BigInt + Date → JSON-safe primitives at the boundary.  Date strings
    // are ISO 8601 UTC; the component parses back with `new Date(...)`
    // for formatting.  `mCents` stays a string so display code can
    // convert via Number() without BigInt overflow risk.
    return json({
      shop,
      host,
      filterStates,
      rows: result.rows.map((row) => ({
        customerScoreId: row.customerScoreId,
        customerId: row.customerId,
        shopifyCustomerId: row.shopifyCustomerId,
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        state: row.state,
        lastOrderAt: row.lastOrderAt?.toISOString() ?? null,
        rDays: row.rDays,
        fCount: row.fCount,
        mCents: row.mCents.toString(),
        currency: row.currency,
        rQuintile: row.rQuintile,
        fQuintile: row.fQuintile,
        mQuintile: row.mQuintile,
        churnRiskScore: row.churnRiskScore,
        computedAt: row.computedAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
    });
  });
}

export default function Customers() {
  const data = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  // IndexTable requires a stateful selection hook even when we don't use
  // selection — passing the rows by id keeps Polaris happy.
  const resourceName = { singular: 'customer', plural: 'customers' };
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(
      data.rows.map((r) => ({ id: r.customerScoreId })),
    );

  function handleStateFilterChange(selected: string[]): void {
    const next = new URLSearchParams(searchParams);
    if (selected.length === 0) {
      next.delete('state');
    } else {
      next.set('state', selected.join(','));
    }
    // Filter change resets pagination.
    next.delete('cursor');
    setSearchParams(next, { replace: true });
  }

  function nextPageHref(): string {
    if (data.nextCursor === null) return '';
    const next = new URLSearchParams(searchParams);
    next.set('cursor', data.nextCursor);
    return `?${next.toString()}`;
  }

  function clearAll(): void {
    const next = new URLSearchParams(searchParams);
    next.delete('state');
    next.delete('cursor');
    setSearchParams(next, { replace: true });
  }

  const filterChoices = ALL_STATES.map((s) => ({
    label: stateLabel(s),
    value: s,
  }));

  return (
    <Page title="Customers">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Filter by state
            </Text>
            <ChoiceList
              title="State"
              titleHidden
              allowMultiple
              choices={filterChoices}
              selected={data.filterStates}
              onChange={handleStateFilterChange}
            />
            {(data.filterStates.length > 0 || data.nextCursor !== null) && (
              <InlineStack align="start">
                <Button variant="plain" onClick={clearAll}>
                  Reset filters + page
                </Button>
              </InlineStack>
            )}
          </BlockStack>
        </Card>

        <Card padding="0">
          {data.rows.length === 0 ? (
            <EmptyState
              heading="No customer scores match"
              image=""
            >
              <p>
                {data.filterStates.length > 0
                  ? 'Adjust the state filter to see more customers, or reset to view all.'
                  : 'Customer scoring runs automatically on first paid order or customer event. New merchants see this view fill as Shopify webhooks land.'}
              </p>
            </EmptyState>
          ) : (
            <IndexTable
              resourceName={resourceName}
              itemCount={data.rows.length}
              selectedItemsCount={
                allResourcesSelected ? 'All' : selectedResources.length
              }
              onSelectionChange={handleSelectionChange}
              selectable={false}
              headings={[
                { title: 'Customer' },
                { title: 'State' },
                { title: 'Churn risk' },
                { title: 'R · F · M' },
                { title: 'Spend (365d)' },
                { title: 'Last order' },
              ]}
            >
              {data.rows.map((row, index) => (
                <IndexTable.Row
                  id={row.customerScoreId}
                  key={row.customerScoreId}
                  position={index}
                >
                  <IndexTable.Cell>
                    <BlockStack gap="050">
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {customerDisplayName(row.firstName, row.lastName, row.email)}
                      </Text>
                      {row.email !== null && (
                        <Text as="span" variant="bodySm" tone="subdued">
                          {row.email}
                        </Text>
                      )}
                    </BlockStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <StateBadge state={row.state} />
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text
                      as="span"
                      variant="bodyMd"
                      tone={row.churnRiskScore === null ? 'subdued' : undefined}
                    >
                      {formatChurnRisk(row.churnRiskScore)}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" variant="bodyMd">
                      {formatRfmTriple(row.rQuintile, row.fQuintile, row.mQuintile)}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" variant="bodyMd">
                      {formatMCents(row.mCents, row.currency)}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" variant="bodyMd">
                      {formatLastOrder(row.lastOrderAt)}
                    </Text>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          )}
        </Card>

        {data.nextCursor !== null && (
          <InlineStack align="end">
            <Link to={nextPageHref()} preventScrollReset>
              <Button>Next page</Button>
            </Link>
          </InlineStack>
        )}
      </BlockStack>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Inline format helpers — pure, route-local.  If `_index.tsx` reuses any of
// these (currently only `stateBadgeProps` is shared) lift to
// apps/web/app/services/customer-score-format.ts at that moment, not now.
// ---------------------------------------------------------------------------

/**
 * Parse the `?state=a,b,c` URL param into a deduped, validated array.
 * Unknown values are silently dropped — defensive against future renames
 * and bookmarked URLs.  Returns `[]` when the param is absent or empty.
 */
function parseFilterStates(raw: string | null): CustomerStateValue[] {
  if (raw === null || raw === '') return [];
  const valid = new Set<CustomerStateValue>(ALL_STATES);
  const seen = new Set<CustomerStateValue>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (valid.has(trimmed as CustomerStateValue)) {
      seen.add(trimmed as CustomerStateValue);
    }
  }
  return [...seen];
}

/**
 * Maps a CustomerState band to a Polaris 13 Badge `tone` + display label.
 * Verified against the `Tone` type at
 * node_modules/@shopify/polaris/.../Badge/types.d.ts — every tone here
 * compiles.  `insufficient_data` gets no tone (default subdued render).
 */
function StateBadge({ state }: { state: CustomerStateValue }) {
  const props = stateBadgeProps(state);
  if (props.tone === undefined) return <Badge>{props.label}</Badge>;
  return <Badge tone={props.tone}>{props.label}</Badge>;
}

function stateBadgeProps(
  state: CustomerStateValue,
): { tone: 'success' | 'info' | 'attention' | 'warning' | 'critical' | undefined; label: string } {
  switch (state) {
    case 'active':
      return { tone: 'success', label: 'Active' };
    case 'warm':
      return { tone: 'info', label: 'Warm' };
    case 'at_risk':
      return { tone: 'attention', label: 'At risk' };
    case 'dormant':
      return { tone: 'warning', label: 'Dormant' };
    case 'lost':
      return { tone: 'critical', label: 'Lost' };
    case 'insufficient_data':
      return { tone: undefined, label: 'Insufficient data' };
  }
}

function stateLabel(state: CustomerStateValue): string {
  return stateBadgeProps(state).label;
}

/**
 * Churn risk as a percentage.  `null` renders as "—" (lurkers +
 * insufficient_data customers — Option 1 from the design pass).
 */
function formatChurnRisk(score: number | null): string {
  if (score === null) return '—';
  return `${Math.round(score * 100)}%`;
}

/**
 * Quintile triple "R · F · M".  Nulls render as "·" placeholder.
 */
function formatRfmTriple(
  r: number | null,
  f: number | null,
  m: number | null,
): string {
  const q = (n: number | null) => (n === null ? '·' : String(n));
  return `${q(r)} · ${q(f)} · ${q(m)}`;
}

/**
 * BigInt cents string → locale-formatted currency.  `Number(cents)/100`
 * is safe for any realistic per-customer trailing-365d sum
 * (Number.MAX_SAFE_INTEGER is 9e15; max realistic spend ≈ 1e11 cents).
 */
function formatMCents(cents: string, currency: string): string {
  const value = Number(cents) / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
    }).format(value);
  } catch {
    // Bad ISO 4217 code — fall back to bare-number display.
    return `${value.toFixed(2)} ${currency}`;
  }
}

/**
 * `lastOrderAt` may be null (customer has no orders) — render as "—".
 * Browser locale; Intl.DateTimeFormat respects the user's preferred
 * date layout (MM/DD/YYYY, DD/MM/YYYY, etc.) automatically.
 */
function formatLastOrder(iso: string | null): string {
  if (iso === null) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso));
}

/**
 * Best-effort display name.  Falls back to email, then to a placeholder.
 */
function customerDisplayName(
  firstName: string | null,
  lastName: string | null,
  email: string | null,
): string {
  if (firstName !== null && lastName !== null) return `${firstName} ${lastName}`;
  if (firstName !== null) return firstName;
  if (lastName !== null) return lastName;
  if (email !== null) return email;
  return 'Unnamed customer';
}
