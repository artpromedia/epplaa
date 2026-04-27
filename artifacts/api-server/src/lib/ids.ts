import { randomBytes } from "node:crypto";

function rand(len = 4): string {
  return randomBytes(len).toString("hex").toUpperCase().slice(0, len);
}

export function newOrderId(): string {
  return `EP-${rand(4)}`;
}

export function newReturnId(): string {
  return `RT-${rand(4)}`;
}

export function newReviewId(): string {
  return `rev_${Date.now().toString(36)}_${rand(3).toLowerCase()}`;
}

export function newWalletTxnId(): string {
  return `wt_${Date.now().toString(36)}_${rand(3).toLowerCase()}`;
}

export function newReportId(): string {
  return `rep-${rand(6)}`;
}

export function newPayoutId(): string {
  return `po_${Date.now().toString(36)}_${rand(3).toLowerCase()}`;
}

export function newPayoutReference(): string {
  return `PO-${Date.now().toString(36).toUpperCase()}-${rand(3)}`;
}

export function newListingId(): string {
  return `lst_${Date.now().toString(36)}_${rand(3).toLowerCase()}`;
}

export function newReferralCode(): string {
  return `EPP-${rand(4)}`;
}

export function newOtp(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

export function newSafeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${rand(3).toLowerCase()}`;
}
