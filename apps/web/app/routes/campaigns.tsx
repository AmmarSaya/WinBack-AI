import { EmptyState, Page } from '@shopify/polaris';

/**
 * Campaigns placeholder. Static page (no loader) per design.md. When
 * Epic G (campaigns + messaging) lands, this becomes a campaign list +
 * the workflow editor; at that point a loader joins back in.
 */
export default function Campaigns() {
  return (
    <Page title="Campaigns">
      <EmptyState
        heading="Campaigns arrive at Epic G"
        image=""
      >
        <p>
          When Epic G (campaigns + messaging) ships, this view shows the
          merchant&apos;s campaign list — workflow status, audience size,
          sends queued, delivery + engagement metrics — plus the workflow
          editor for building new campaigns.
        </p>
      </EmptyState>
    </Page>
  );
}
