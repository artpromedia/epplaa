import { createContext, ReactNode, useCallback, useContext, useMemo } from "react";
import {
  useListSafetyReports,
  useListBlockedSellers,
  useSubmitSafetyReport,
  useBlockSeller,
  useUnblockSeller,
  useListMyTakedowns,
  useAppealTakedown,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export type ReportTargetKind = "product" | "stream" | "seller" | "message";

export type ReportReason =
  | "counterfeit"
  | "scam"
  | "harassment"
  | "hate_speech"
  | "graphic"
  | "misleading"
  | "underage"
  | "ip_violation"
  | "other";

export const REPORT_REASONS: { id: ReportReason; label: string; detail: string }[] = [
  { id: "counterfeit", label: "Counterfeit goods", detail: "Suspected fake or knock-off." },
  { id: "scam", label: "Scam or fraud", detail: "Item or seller looks fraudulent." },
  { id: "harassment", label: "Harassment", detail: "Threatening or abusive behavior." },
  { id: "hate_speech", label: "Hate speech", detail: "Discrimination or slurs." },
  { id: "graphic", label: "Graphic content", detail: "Violent or explicit material." },
  { id: "misleading", label: "Misleading claims", detail: "False or exaggerated description." },
  { id: "underage", label: "Underage seller", detail: "Looks like a minor selling." },
  { id: "ip_violation", label: "IP violation", detail: "Brand or trademark misuse." },
  { id: "other", label: "Something else", detail: "Tell us more in the notes." },
];

export type ReportStatus = "submitted" | "in_review" | "resolved" | "dismissed";

export interface SafetyReport {
  id: string;
  targetKind: ReportTargetKind;
  targetId: string;
  targetLabel: string;
  reason: ReportReason;
  notes: string;
  status: ReportStatus;
  createdAtIso: string;
  updatedAtIso: string;
  blockedAtSubmit: boolean;
  caseId: string | null;
  caseStatus: string | null;
}

export interface BlockedSeller {
  sellerName: string;
  reason: ReportReason | "manual";
  atIso: string;
}

/**
 * A takedown affecting the current user, surfaced in the safety hub
 * so sellers see what was removed and can file an appeal. We omit the
 * operator's `actorUserId` from the buyer-facing surface — the server
 * still returns it on the shared `Takedown` shape (since the operator
 * console reads the same endpoint family), but the safety hub never
 * renders it.
 */
export interface MyTakedown {
  id: string;
  targetKind: string;
  targetId: string;
  reasonCode: string;
  notifiedAtIso: string | null;
  notes: string;
  createdAtIso: string;
  caseId: string | null;
  /** open | triage | in_review | action | closed | null */
  caseStatus: string | null;
}

interface SafetyContextValue {
  reports: SafetyReport[];
  blocked: BlockedSeller[];
  takedowns: MyTakedown[];
  submitReport: (input: {
    targetKind: ReportTargetKind;
    targetId: string;
    targetLabel: string;
    reason: ReportReason;
    notes?: string;
    blockSeller?: boolean;
    sellerName?: string;
  }) => SafetyReport;
  blockSeller: (sellerName: string, reason?: ReportReason | "manual") => void;
  unblockSeller: (sellerName: string) => void;
  isBlocked: (sellerName: string) => boolean;
  appealTakedown: (takedownId: string, reason: string) => Promise<void>;
  reset: () => void;
}

const SafetyContext = createContext<SafetyContextValue | null>(null);

export function SafetyProvider({ children }: { children: ReactNode }) {
  const reportsQuery = useListSafetyReports();
  const blockedQuery = useListBlockedSellers();
  const takedownsQuery = useListMyTakedowns();
  const qc = useQueryClient();

  const invalidateReports = useCallback(
    () => qc.invalidateQueries({ queryKey: ["/api/safety/reports"] }),
    [qc],
  );
  const invalidateBlocked = useCallback(
    () => qc.invalidateQueries({ queryKey: ["/api/safety/blocked"] }),
    [qc],
  );
  const invalidateTakedowns = useCallback(
    () => qc.invalidateQueries({ queryKey: ["/api/admin/takedowns/mine"] }),
    [qc],
  );

  const submitMut = useSubmitSafetyReport({
    mutation: { onSuccess: () => { invalidateReports(); invalidateBlocked(); } },
  });
  const blockMut = useBlockSeller({ mutation: { onSuccess: invalidateBlocked } });
  const unblockMut = useUnblockSeller({ mutation: { onSuccess: invalidateBlocked } });
  // Appeal posts to /admin/takedowns/:id/appeal. We refetch the
  // takedowns list on success so the surfaced `caseStatus` flips to
  // "in_review", which the UI uses to disable the appeal button.
  const appealMut = useAppealTakedown({
    mutation: { onSuccess: invalidateTakedowns },
  });

  const reports = useMemo<SafetyReport[]>(
    () =>
      (reportsQuery.data ?? []).map((r) => ({
        id: r.id,
        targetKind: r.targetKind as ReportTargetKind,
        targetId: r.targetId,
        targetLabel: r.targetLabel,
        reason: r.reason as ReportReason,
        notes: r.notes,
        status: r.status as ReportStatus,
        createdAtIso: r.createdAtIso,
        updatedAtIso: r.updatedAtIso,
        blockedAtSubmit: r.blockedAtSubmit,
        caseId: (r as { caseId?: string | null }).caseId ?? null,
        caseStatus: (r as { caseStatus?: string | null }).caseStatus ?? null,
      })),
    [reportsQuery.data],
  );

  const blocked = useMemo<BlockedSeller[]>(
    () =>
      (blockedQuery.data ?? []).map((b) => ({
        sellerName: b.sellerName,
        reason: b.reason as ReportReason | "manual",
        atIso: b.atIso,
      })),
    [blockedQuery.data],
  );

  const takedowns = useMemo<MyTakedown[]>(
    () =>
      (takedownsQuery.data ?? []).map((t) => ({
        id: t.id,
        targetKind: t.targetKind,
        targetId: t.targetId,
        reasonCode: t.reasonCode,
        notifiedAtIso: t.notifiedAtIso ?? null,
        // Generated client marks these optional because they aren't in
        // the schema's `required` list (omitted to keep the operator
        // console schema lean). The buyer-app needs concrete strings,
        // so we default to empty / now to avoid a render-time crash.
        notes: t.notes ?? "",
        createdAtIso: t.createdAtIso ?? new Date(0).toISOString(),
        caseId: (t as { caseId?: string | null }).caseId ?? null,
        caseStatus: (t as { caseStatus?: string | null }).caseStatus ?? null,
      })),
    [takedownsQuery.data],
  );

  const isBlocked = useCallback(
    (sellerName: string) => blocked.some((b) => b.sellerName === sellerName),
    [blocked],
  );

  const blockSeller = useCallback(
    (sellerName: string, reason: ReportReason | "manual" = "manual") => {
      blockMut.mutate({ data: { sellerName, reason } });
    },
    [blockMut],
  );

  const unblockSeller = useCallback(
    (sellerName: string) => unblockMut.mutate({ sellerName }),
    [unblockMut],
  );

  const submitReport = useCallback<SafetyContextValue["submitReport"]>(
    ({ targetKind, targetId, targetLabel, reason, notes = "", blockSeller: blockOnSubmit = false, sellerName }) => {
      submitMut.mutate({
        data: {
          targetKind,
          targetId,
          targetLabel,
          reason,
          notes,
          blockSeller: blockOnSubmit,
          ...(sellerName ? { sellerName } : {}),
        },
      });
      const now = new Date().toISOString();
      return {
        id: `tmp-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        targetKind,
        targetId,
        targetLabel,
        reason,
        notes,
        status: "submitted",
        createdAtIso: now,
        updatedAtIso: now,
        blockedAtSubmit: blockOnSubmit,
        caseId: null,
        caseStatus: null,
      };
    },
    [submitMut],
  );

  const appealTakedown = useCallback(
    async (takedownId: string, reason: string) => {
      // mutateAsync surfaces the 403/404 to the caller so the UI can
      // toast a contextual error; on success the onSuccess handler
      // refetches the takedowns list.
      await appealMut.mutateAsync({ id: takedownId, data: { reason } });
    },
    [appealMut],
  );

  const reset = useCallback(() => {
    blocked.forEach((b) => unblockMut.mutate({ sellerName: b.sellerName }));
  }, [blocked, unblockMut]);

  const value = useMemo<SafetyContextValue>(
    () => ({
      reports,
      blocked,
      takedowns,
      submitReport,
      blockSeller,
      unblockSeller,
      isBlocked,
      appealTakedown,
      reset,
    }),
    [
      reports,
      blocked,
      takedowns,
      submitReport,
      blockSeller,
      unblockSeller,
      isBlocked,
      appealTakedown,
      reset,
    ],
  );

  return <SafetyContext.Provider value={value}>{children}</SafetyContext.Provider>;
}

export function useSafety() {
  const ctx = useContext(SafetyContext);
  if (!ctx) throw new Error("useSafety must be used within SafetyProvider");
  return ctx;
}

export function reportReasonLabel(reason: ReportReason): string {
  return REPORT_REASONS.find((r) => r.id === reason)?.label ?? "Reported";
}
