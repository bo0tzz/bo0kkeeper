export enum ExitCode {
  Success = 0,
  Failure = 1,
  AppRestart = 250,
}

export enum LogLevel {
  Verbose = 'verbose',
  Debug = 'debug',
  Log = 'log',
  Warn = 'warn',
  Error = 'error',
  Fatal = 'fatal',
}

/** Source of an event in the durable event log. */
export enum EventSource {
  Wise = 'wise',
  Paperless = 'paperless',
  Bank = 'bank',
  Manual = 'manual',
  System = 'system',
}

/** Lifecycle status of an event row. */
export enum EventStatus {
  Pending = 'pending',
  Processing = 'processing',
  Processed = 'processed',
  Failed = 'failed',
  Skipped = 'skipped',
}

/** pg-boss queue names. */
export enum QueueName {
  Default = 'default',
  Webhook = 'webhook',
}

/** Job names; every value must have exactly one @OnJob handler at boot. */
export enum JobName {
  /** Apply a Wise `transfers#state-change` event to its `wise_transfer` row. */
  WiseTransferStateChange = 'wise.transfer.state_change',
  /** Convert a paperless `document.consumed` event into a pending expense. */
  ProcessPaperlessDocument = 'paperless.document.consumed',
  /**
   * Re-render an invoice and upload to paperless. Enqueued when the inline
   * upload during compose fails (paperless down, network blip, etc.) so the
   * archive eventually completes once paperless is reachable again.
   */
  ArchiveInvoiceToPaperless = 'invoice.archive_to_paperless',
  /**
   * Pull new transactions from every active Enable Banking session, dedupe,
   * and run the matcher. Cron-scheduled (every 6h, the PSD2 background cap)
   * and also enqueueable on demand from the admin "Sync now" button.
   */
  BankingSyncAll = 'banking.sync_all',
  /**
   * GC banking_session rows stuck in `pending` past their TTL — abandoned
   * "Connect bank" attempts where the user never finished SCA at the bank.
   * Daily cron is plenty.
   */
  BankingSweepStalePending = 'banking.sweep_stale_pending',
  /**
   * Pull non-terminal `wise_transfer` rows from the Wise API and reapply
   * their state. Belt-and-braces against missed `transfers#state-change`
   * webhooks — without it, a single dropped delivery would leave a transfer
   * showing the wrong state forever.
   */
  WiseReconcile = 'wise.reconcile',
}

/** Tax/billing classification of a client; drives BTW treatment + invoice template selection. */
export enum ClientClass {
  /** Outside scope of EU VAT (the regular US client). */
  NonEu = 'non_eu',
  /** B2B EU with valid VAT exchange — reverse-charge. */
  EuReverseCharge = 'eu_reverse_charge',
  /** EU vendor that does charge Dutch BTW. */
  Eu = 'eu',
  /** Dutch domestic. */
  Domestic = 'domestic',
}

/** The two trade names operated under one legal entity. */
export enum TradeName {
  ItServices = 'it_services',
  ThreeD = '3d',
}

export enum WiseTransferDirection {
  In = 'in',
  Out = 'out',
  /** USD→EUR conversion within the same Wise account; observed but doesn't move external money. */
  Neutral = 'neutral',
}

/**
 * Wise transfer lifecycle, sourced from `transfers.state-change` events.
 * Not exhaustive — Wise has more, but these are the ones we care about for the
 * happy path and a couple of failure modes.
 */
export enum WiseTransferState {
  IncomingPaymentWaiting = 'incoming_payment_waiting',
  Processing = 'processing',
  FundsConverted = 'funds_converted',
  OutgoingPaymentSent = 'outgoing_payment_sent',
  Cancelled = 'cancelled',
  Failed = 'failed',
}

/** Origin of a bank-transaction row. */
export enum BankSource {
  SnsCsv = 'sns_csv',
  EnableBanking = 'enable_banking',
}

export enum MatchConfidence {
  AutoHigh = 'auto_high',
  AutoLow = 'auto_low',
  Manual = 'manual',
}

/** Lifecycle of an Enable Banking PSD2 session. */
export enum BankingSessionStatus {
  /** Auth started; awaiting callback from bank. Garbage-collected after 1h. */
  Pending = 'pending',
  /** Session created; PSU consent valid through `expiresAt`. */
  Active = 'active',
  /** Past `expiresAt` or PSD2-mandated reauth needed. */
  Expired = 'expired',
  /** User revoked at the bank, or we hit a 401 from the API. */
  Revoked = 'revoked',
}

/** Lifecycle of a paperless-extracted expense row. */
export enum ExpenseStatus {
  PendingReview = 'pending_review',
  Approved = 'approved',
  Rejected = 'rejected',
}

/** Tax-treatment classification of an expense, parallel to ClientClass. */
export enum ExpenseLocationClass {
  Domestic = 'domestic',
  Eu = 'eu',
  EuReverseCharge = 'eu_reverse_charge',
  NonEu = 'non_eu',
}
