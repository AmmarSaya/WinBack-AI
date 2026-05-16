import { EmptyState, Page } from '@shopify/polaris';

/**
 * Customers placeholder. Static page (no loader) — see design.md
 * "Tests on loader routes only." When Epic E (RFM + churn scoring) lands,
 * this becomes a real customer list driven by the CustomerScore / Segment
 * tables; at that point a loader joins back in.
 *
 * Why a placeholder route exists at all: keeps the App Bridge nav menu
 * in root.tsx pointing at a real URL today, so the merchant can click
 * "Customers" without getting a 404. Empty-state copy is honest about
 * which Epic unlocks it.
 */
export default function Customers() {
  return (
    <Page title="Customers">
      <EmptyState
        heading="Customer intelligence arrives at Epic E"
        // Polaris EmptyState requires an image prop. An empty string is
        // valid and renders no image — preferable to a stock illustration
        // that implies the feature is half-built.
        image=""
      >
        <p>
          When Epic E (RFM scoring + churn detection) ships, this view shows
          the merchant&apos;s customer list with state (active / warm /
          at-risk / dormant / lost), VIP flag, and segment membership —
          filterable, sortable, drillable.
        </p>
      </EmptyState>
    </Page>
  );
}
