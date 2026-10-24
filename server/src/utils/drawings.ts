/** How salary payouts are recognised; operator-editable on /settings. */
export type DrawingsRule = {
  /** The operator's personal account IBANs. Empty disables the rule. */
  ibans: string[];
  /** Case-insensitive phrase the transfer description must contain; empty matches any. */
  descriptionContains: string;
};

type BankTxLike = {
  amountMinor: bigint | string;
  counterpartyIban: string | null;
  description: string | null;
};

/**
 * A salary payout: money going out to one of the operator's own accounts
 * with the agreed description. Other transfers to the same account (e.g.
 * reimbursing a business cost paid privately) don't carry the phrase and
 * are left to the regular matching.
 */
export function isSalaryPayout(tx: BankTxLike, rule: DrawingsRule): boolean {
  if (BigInt(tx.amountMinor) >= 0n || !tx.counterpartyIban) {
    return false;
  }
  const iban = normalizeIban(tx.counterpartyIban);
  if (rule.ibans.every((own) => normalizeIban(own) !== iban)) {
    return false;
  }
  const phrase = rule.descriptionContains.trim().toLowerCase();
  return !phrase || (tx.description ?? '').toLowerCase().includes(phrase);
}

function normalizeIban(iban: string): string {
  return iban.replaceAll(/\s+/g, '').toUpperCase();
}
