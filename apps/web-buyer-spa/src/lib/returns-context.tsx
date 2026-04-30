import { createContext, ReactNode, useCallback, useContext, useMemo } from "react";
import {
  useListReturns,
  useCreateReturn,
  useTransitionReturn,
  useAppendReturnMessage,
  type ReturnRecord as ApiReturnRecord,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export type ReturnReason =
  | "wrong_item"
  | "defective"
  | "not_described"
  | "size_fit"
  | "damaged_in_transit"
  | "changed_mind"
  | "other";

export const RETURN_REASONS: { id: ReturnReason; label: string; needsPhoto: boolean }[] = [
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
  }) => Promise<ReturnRecord>;
  approveReturn: (id: string) => void;
  rejectReturn: (id: string, reason: string) => void;
  markShippedBack: (id: string) => void;
  refund: (id: string) => void;
  openDispute: (id: string, message: string) => void;
  postMessage: (id: string, msg: Omit<DisputeMessage, "id" | "atIso">) => void;
}

const ReturnsContext = createContext<ReturnsContextValue | null>(null);

const TIMELINE_LABELS: Record<ReturnTimelineEvent["status"], string> = {
  requested: "Return requested",
  approved: "Return approved",
  in_dispute: "Dispute opened",
  rejected: "Return rejected",
  shipped_back: "Item shipped back",
  refunded: "Refund issued",
  note: "Note",
};

function fromApi(r: ApiReturnRecord): ReturnRecord {
  return {
    id: r.id,
    orderId: r.orderId,
    productTitle: r.productTitle,
    productImage: r.productImage ?? undefined,
    refundAmountMinor: r.refundAmountMinor,
    currencyCode: r.currencyCode,
    reason: r.reason as ReturnReason,
    reasonLabel: r.reasonLabel,
    notes: r.notes,
    photoCount: r.photoCount,
    status: r.status as ReturnStatus,
    createdAtIso: r.createdAtIso,
    timeline: ((r.timeline ?? []) as unknown as Array<Record<string, unknown>>).map((t) => {
      const status = (t.status as ReturnTimelineEvent["status"]) ?? "note";
      const labelFromServer = t.label ? String(t.label) : "";
      return {
        status,
        atIso: String(t.atIso ?? ""),
        label: labelFromServer || TIMELINE_LABELS[status] || "Update",
        detail: t.note ? String(t.note) : t.detail ? String(t.detail) : undefined,
        byRole:
          t.actor === "epplaa"
            ? "support"
            : (t.actor as ReturnTimelineEvent["byRole"]) ?? undefined,
      };
    }),
    dispute: ((r.dispute ?? []) as unknown as Array<Record<string, unknown>>).map((d, i) => ({
      id: String(d.id ?? `m_${i}`),
      byRole:
        d.actor === "epplaa"
          ? "support"
          : ((d.actor as DisputeMessage["byRole"]) ?? "buyer"),
      body: String(d.body ?? ""),
      atIso: String(d.atIso ?? ""),
    })),
  };
}

export function ReturnsProvider({ children }: { children: ReactNode }) {
  const query = useListReturns();
  const qc = useQueryClient();

  const invalidateAll = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["/api/returns"] });
    // A refunded transition auto-credits the wallet server-side; refetch.
    qc.invalidateQueries({ queryKey: ["/api/wallet"] });
  }, [qc]);

  const createMut = useCreateReturn({ mutation: { onSuccess: invalidateAll } });
  const transitionMut = useTransitionReturn({ mutation: { onSuccess: invalidateAll } });
  const messageMut = useAppendReturnMessage({ mutation: { onSuccess: invalidateAll } });

  const returns = useMemo<ReturnRecord[]>(
    () => (query.data ?? []).map(fromApi),
    [query.data],
  );

  const request = useCallback<ReturnsContextValue["request"]>(
    async (input) => {
      const result = await createMut.mutateAsync({
        data: { ...input } as Record<string, unknown>,
      });
      return fromApi(result);
    },
    [createMut],
  );

  const transition = useCallback(
    (id: string, status: ReturnStatus, detail?: string) => {
      transitionMut.mutate({
        returnId: id,
        data: { status, ...(detail ? { detail } : {}) },
      });
    },
    [transitionMut],
  );

  const approveReturn = useCallback((id: string) => transition(id, "approved"), [transition]);
  const rejectReturn = useCallback(
    (id: string, reason: string) => transition(id, "rejected", reason),
    [transition],
  );
  const markShippedBack = useCallback((id: string) => transition(id, "shipped_back"), [transition]);
  const refund = useCallback((id: string) => transition(id, "refunded"), [transition]);

  const openDispute = useCallback(
    (id: string, message: string) => {
      transitionMut.mutate(
        { returnId: id, data: { status: "in_dispute" } },
        {
          onSuccess: () => {
            messageMut.mutate({
              returnId: id,
              data: { actor: "buyer", body: message },
            });
          },
        },
      );
    },
    [transitionMut, messageMut],
  );

  const postMessage = useCallback<ReturnsContextValue["postMessage"]>(
    (id, msg) => {
      messageMut.mutate({
        returnId: id,
        data: {
          actor: msg.byRole === "support" ? "epplaa" : msg.byRole,
          body: msg.body,
        },
      });
    },
    [messageMut],
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
    [returns, byOrder, getById, request, approveReturn, rejectReturn, markShippedBack, refund, openDispute, postMessage],
  );

  return <ReturnsContext.Provider value={value}>{children}</ReturnsContext.Provider>;
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
