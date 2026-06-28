/**
 * `pnpm cli:dispatch:smoke --to <verified-address>`
 *
 * Operator command — sends ONE email via the real SES adapter pointed at the
 * sandbox, to a verified test address. Prints the providerMessageId on success
 * and exits. Pure adapter smoke: NO database writes, NO repo calls, NO audit,
 * NO MessageQuotaBucket increment. The goal is to confirm that the adapter
 * actually talks to SES (env, credentials, configuration set, region).
 *
 * WHY NOT IN CI: CI has no AWS credentials and no outbound-network policy for
 * outbound SES. This is a human-gated check the operator runs once when 8.4
 * lands (or when SES env changes).
 *
 * SANDBOX HARD-ASSERTION: the command refuses to run unless
 * `AWS_SES_SANDBOX=true`. The 8.4 build assumption is sandbox-only; sending
 * to a random address against a production-out-of-sandbox account from this
 * smoke would be a deliverability hazard.
 *
 * Ops env (one shell): EMAIL_PROVIDER + AWS_REGION + AWS_SES_ACCESS_KEY_ID +
 * AWS_SES_SECRET_ACCESS_KEY + AWS_SES_FROM_ADDRESS + AWS_SES_CONFIGURATION_SET
 * + AWS_SES_SANDBOX=true. Same env names @winback/email's `getEmailConfig`
 * validates at boot.
 */

import { getEmailConfig, selectActiveEmailProvider } from '@winback/email';

export type DispatchSmokeResult =
  | { kind: 'sandbox_required' }
  | { kind: 'sent'; providerMessageId: string; latencyMs: number };

export interface RunDispatchSmokeArgs {
  readonly to: string;
  readonly subject?: string;
  readonly bodyHtml?: string;
}

export async function runDispatchSmoke(
  args: RunDispatchSmokeArgs,
): Promise<DispatchSmokeResult> {
  const config = getEmailConfig({ reset: true });

  // Sandbox hard-assertion. 8.4 is sandbox-only; running this from a
  // production-out-of-sandbox env should require an EXPLICIT later edit to
  // the smoke command, not a silent env flip.
  if (!config.AWS_SES_SANDBOX) {
    return { kind: 'sandbox_required' };
  }

  const provider = selectActiveEmailProvider(config);
  const fromAddress = config.AWS_SES_FROM_ADDRESS;
  const configurationSetName = config.AWS_SES_CONFIGURATION_SET;

  const subject = args.subject ?? 'WinBack AI — sandbox smoke';
  const html =
    args.bodyHtml ??
    '<p>SES sandbox smoke from <strong>WinBack AI</strong>. No DB writes; provider-only.</p>';

  const accepted = await provider.send({
    from: fromAddress,
    to: args.to,
    subject,
    html,
    // Synthetic correlation id so an eventual SNS event (8.5) can show the
    // tag round-trip. NOT a real CampaignTarget.id — distinguishable as a
    // smoke source.
    correlationId: `smoke-${Date.now().toString(36)}`,
    ...(configurationSetName !== undefined ? { configurationSetName } : {}),
  });

  return {
    kind: 'sent',
    providerMessageId: accepted.providerMessageId,
    latencyMs: accepted.latencyMs,
  };
}
