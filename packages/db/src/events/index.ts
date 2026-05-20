// =============================================================================
// @winback/db — outbox event producer-side schemas.
//
// Producer schemas describe payloads we WRITE to OutboxEvent.payload.  They
// are distinct from the drainer-side parse schemas in
// `apps/drainer/src/payload-schemas.ts` — the drainer re-parses every
// payload it pulls from the table as a defense-in-depth contract check.
//
// File-per-event so that a future Epic G/F consumer can import a single
// payload schema without dragging in unrelated event types.
// =============================================================================

export {
  buildCustomerStateChangedPayload,
  customerStateChangedPayloadSchema,
  customerStateSchema,
  customerStateValues,
  rfmScoreSchema,
  type CustomerStateChangedInput,
  type CustomerStateChangedPayload,
  type CustomerStateValue,
  type RfmScore,
} from './customer-state-changed.js';
