export { BaseRepository } from './base.js';
export {
  MerchantSettingsRepository,
  type MerchantSettingsUpdate,
} from './merchant-settings.repository.js';
export {
  MerchantRepository,
  type UpsertInstallArgs,
  type UpdateEnrichmentArgs,
} from './merchant.repository.js';
export { OutboxRepository, type OutboxEventRow } from './outbox.repository.js';
export { AuditLogRepository, type AppendAuditLogInput } from './audit-log.repository.js';
export {
  CustomerRepository,
  type SoftDeleteCustomerArgs,
  type SoftDeleteCustomerResult,
  type UpsertCustomerFromWebhookArgs,
  type UpsertCustomerFromWebhookResult,
} from './customer.repository.js';
export {
  CustomerScoreRepository,
  type CustomerScoreCohortRow,
  type ListCustomerScoresArgs,
  type ListCustomerScoresResult,
  type ListedCustomerScore,
  type UpsertCustomerScoreArgs,
  type UpsertCustomerScoreResult,
} from './customer-score.repository.js';
export {
  OrderRepository,
  type QualifyingTransition,
  type UpsertOrderFromWebhookArgs,
  type UpsertOrderFromWebhookResult,
} from './order.repository.js';
export {
  BackfillJobRepository,
  type BackfillJob,
  type BackfillStatus,
} from './backfill-job.repository.js';

// --- Epic F batch 3 (AI generation, message, spend ledger) -----------------
export {
  AiGenerationRepository,
  type CreatePendingArgs,
  type MarkCompletedArgs,
  type MarkFailedArgs,
} from './ai-generation.repository.js';
export {
  MessageRepository,
  type CreateDraftArgs,
  type UpdateGeneratedTextArgs,
} from './message.repository.js';
export {
  AiSpendBucketRepository,
  type GetOrCreateForDayArgs,
  type IncrementSpendArgs,
  type SumMonthSpendArgs,
} from './ai-spend-bucket.repository.js';
