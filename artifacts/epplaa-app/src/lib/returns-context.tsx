import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useMemo,
} from "react";
import { useLocalStorage } from "./use-local-storage";

export type ReturnReason =
  | "wrong_item"
  | "defective"
  | "not_described"
  | "size_fit"
  | "damaged_in_transit"
  | "changed_mind"
  | "other";

export const RETURN_REASONS: { id: ReturnReason; label: string; needsPhoto: boolean }[] =
  [
    { id: "wrong_item", label: "Wrong item received", needsPhoto: true },
    { id: "defective", label: "Defective or not working", needsPhoto: true },
    { id: "damaged_in_transit", label: "Damaged in transit", needsPhoto: true },
    { id: "not_described", label: "Not as described", needsPhoto: true },
    { id: "size_fit", label: "Size or fit issue", needsPhoto: false },
    { id: "changed_mind", label: "Changed my mind", needsPhoto: false },
    { id: "other", label: "Other reason", needsPhoto: false },
  ];

export type ReturnStatus =
  | "requested"
  | "approved"
  | "in_dispute"
  | "rejected"
  | "shipped_back"
  | "refunded";

export interface ReturnTimelineEvent {
  status: ReturnStatus | "note";
  atIso: string;
  label: string;
  detail?: string;
  byRole?: "buyer" | "seller" | "support";
}

export interface DisputeMessage {
  id: string;
  byRole: "buyer" | "seller" | "support";
  body: string;
  atIso: string;
}

export interface ReturnRecord {
  id: string;
  orderId: string;
  productTitle: string;
  productImage?: string;
  refundAmountMinor: number;
  currencyCode: string;
  reason: ReturnReason;
  reasonLabel: string;
  notes: string;
  photoCount: number;
  status: ReturnStatus;
  createdAtIso: string;
  timeline: ReturnTimelineEvent[];
  dispute: DisputeMessage[];
}

interface ReturnsContextValue {
  returns: ReturnRecord[];
  byOrder: (orderId: string) => ReturnRecord | undefined;
  getById: (id: string) => ReturnRecord | undefined;
  request: (input: {
    orderId: string;
    productTitle: string;
    productImage?: string;
    refundAmountMinor: number;
    currencyCode: string;
    reason: ReturnReason;
    notes: string;
    photoCount: number;
  }) => ReturnRecord;
  approveReturn: (id: string) => void;
  rejectReturn: (id: string, reason: string) => void;
  markShippedBack: (id: string) => void;
  refund: (id: string) => void;
  openDispute: (id: string, message: string) => void;
  postMessage: (id: string, msg: Omit<DisputeMessage, "id" | "atIso">) => void;
}

const ReturnsContext = createContext<ReturnsContextValue | null>(null);
const STORAGE_KEY = "epplaa-returns";

function reasonLabel(r: ReturnReason): string {
  return RETURN_REASONS.find((x) => x.id === r)?.label ?? r;
}

function makeId() {
  return `RT-${Date.now().toString(36).toUpperCase()}${Math.random()
    .toString(36)
    .slice(2, 4)
    .toUpperCase()}`;
}

export function ReturnsProvider({
  children,
  onRefund,
}: {
  children: ReactNode;
  onRefund?: (rec: ReturnRecord) => void;
}) {
  const [returns, setReturns] = useLocalStorage<ReturnRecord[]>(STORAGE_KEY, []);

  const update = useCallback(
    (id: string, fn: (r: ReturnRecord) => ReturnRecord) =>
      setReturns((prev) => prev.map((r) => (r.id === id ? fn(r) : r))),
    [setReturns],
  );

  const request = useCallback<ReturnsContextValue["request"]>(
    (input) => {
      const now = new Date().toISOString();
      const rec: ReturnRecord = {
        id: makeId(),
        orderId: input.orderId,
        productTitle: input.productTitle,
        productImage: input.productImage,
        refundAmountMinor: input.refundAmountMinor,
        currencyCode: input.currencyCode,
        reason: input.reason,
        reasonLabel: reasonLabel(input.reason),
        notes: input.notes,
        photoCount: input.photoCount,
        status: "requested",
        createdAtIso: now,
        timeline: [
          {
            status: "requested",
            atIso: now,
            label: "Return requested",
            detail: reasonLabel(input.reason),
            byRole: "buyer",
          },
        ],
        dispute: [],
      };
      setReturns((prev) => [rec, ...prev]);
      return rec;
    },
    [setReturns],
  );

  const approveReturn = useCallback(
    (id: string) =>
      update(id, (r) => ({
        ...r,
        status: "approved",
        timeline: [
          ...r.timeline,
          {
            status: "approved",
            atIso: new Date().toISOString(),
            label: "Return approved",
            detail: "Ship the item back within 5 days using the prepaid label.",
            byRole: "seller",
          },
        ],
      })),
    [update],
  );

  const rejectReturn = useCallback(
    (id: string, reason: string) =>
      update(id, (r) => ({
        ...r,
        status: "rejected",
        timeline: [
          ...r.timeline,
          {
            status: "rejected",
            atIso: new Date().toISOString(),
            label: "Return rejected",
            detail: reason,
            byRole: "seller",
          },
        ],
      })),
    [update],
  );

  const markShippedBack = useCallback(
    (id: string) =>
      update(id, (r) => ({
        ...r,
        status: "shipped_back",
        timeline: [
          ...r.timeline,
          {
            status: "shipped_back",
            atIso: new Date().toISOString(),
            label: "Item shipped back",
            detail: "Tracking handed to courier.",
            byRole: "buyer",
          },
        ],
      })),
    [update],
  );

  const refund = useCallback(
    (id: string) => {
      const target = returns.find((r) => r.id === id);
      if (!target) return;
      // Idempotency guard: never re-issue a refund. Only approved/received
      // returns can transition to "refunded" — this protects the wallet
      // bridge from being called twice for the same return.
      if (target.status === "refunded") return;
      if (target.status !== "approved" && target.status !== "shipped_back")
        return;
      const updated: ReturnRecord = {
        ...target,
        status: "refunded",
        timeline: [
          ...target.timeline,
          {
            status: "refunded",
            atIso: new Date().toISOString(),
            label: "Refund issued",
            detail: "Credited to your Epplaa wallet within seconds.",
            byRole: "support",
          },
        ],
      };
      setReturns((prev) => prev.map((r) => (r.id === id ? updated : r)));
      onRefund?.(updated);
    },
    [onRefund, returns, setReturns],
  );

  const openDispute = useCallback(
    (id: string, message: string) =>
      update(id, (r) => ({
        ...r,
        status: "in_dispute",
        timeline: [
          ...r.timeline,
          {
            status: "in_dispute",
            atIso: new Date().toISOString(),
            label: "Dispute opened",
            detail: "Support team will review within 24 hours.",
            byRole: "buyer",
          },
        ],
        dispute: [
          ...r.dispute,
          {
            id: `dm_${Date.now()}`,
            byRole: "buyer",
            body: message,
            atIso: new Date().toISOString(),
          },
        ],
      })),
    [update],
  );

  const postMessage = useCallback<ReturnsContextValue["postMessage"]>(
    (id, msg) =>
      update(id, (r) => ({
        ...r,
        dispute: [
          ...r.dispute,
          { id: `dm_${Date.now()}`, atIso: new Date().toISOString(), ...msg },
        ],
      })),
    [update],
  );

  const byOrder = useCallback(
    (orderId: string) => returns.find((r) => r.orderId === orderId),
    [returns],
  );

  const getById = useCallback(
    (id: string) => returns.find((r) => r.id === id),
    [returns],
  );

  const value = useMemo<ReturnsContextValue>(
    () => ({
      returns,
      byOrder,
      getById,
      request,
      approveReturn,
      rejectReturn,
      markShippedBack,
      refund,
      openDispute,
      postMessage,
    }),
    [
      returns,
      byOrder,
      getById,
      request,
      approveReturn,
      rejectReturn,
      markShippedBack,
      refund,
      openDispute,
      postMessage,
    ],
  );

  return (
    <ReturnsContext.Provider value={value}>{children}</ReturnsContext.Provider>
  );
}

export function useReturns(): ReturnsContextValue {
  const ctx = useContext(ReturnsContext);
  if (!ctx) throw new Error("useReturns must be used inside ReturnsProvider");
  return ctx;
}

export const RETURN_STATUS_LABEL: Record<ReturnStatus, string> = {
  requested: "Requested",
  approved: "Approved",
  in_dispute: "In dispute",
  rejected: "Rejected",
  shipped_back: "Shipped back",
  refunded: "Refunded",
};
