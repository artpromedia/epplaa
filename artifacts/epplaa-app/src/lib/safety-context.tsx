import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useMemo,
} from "react";
import { useLocalStorage } from "./use-local-storage";

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
}

export interface BlockedSeller {
  sellerName: string;
  reason: ReportReason | "manual";
  atIso: string;
}

interface SafetyContextValue {
  reports: SafetyReport[];
  blocked: BlockedSeller[];
  submitReport: (
    input: {
      targetKind: ReportTargetKind;
      targetId: string;
      targetLabel: string;
      reason: ReportReason;
      notes?: string;
      blockSeller?: boolean;
      sellerName?: string;
    },
  ) => SafetyReport;
  blockSeller: (sellerName: string, reason?: ReportReason | "manual") => void;
  unblockSeller: (sellerName: string) => void;
  isBlocked: (sellerName: string) => boolean;
  reset: () => void;
}

const SafetyContext = createContext<SafetyContextValue | null>(null);
const REPORTS_KEY = "epplaa-safety-reports";
const BLOCKED_KEY = "epplaa-safety-blocked";

export function SafetyProvider({ children }: { children: ReactNode }) {
  const [reports, setReports] = useLocalStorage<SafetyReport[]>(REPORTS_KEY, []);
  const [blocked, setBlocked] = useLocalStorage<BlockedSeller[]>(BLOCKED_KEY, []);

  const blockSeller = useCallback(
    (sellerName: string, reason: ReportReason | "manual" = "manual") => {
      setBlocked((prev) =>
        prev.some((b) => b.sellerName === sellerName)
          ? prev
          : [
              ...prev,
              { sellerName, reason, atIso: new Date().toISOString() },
            ],
      );
    },
    [setBlocked],
  );

  const unblockSeller = useCallback(
    (sellerName: string) => {
      setBlocked((prev) => prev.filter((b) => b.sellerName !== sellerName));
    },
    [setBlocked],
  );

  const isBlocked = useCallback(
    (sellerName: string) => blocked.some((b) => b.sellerName === sellerName),
    [blocked],
  );

  const submitReport = useCallback<SafetyContextValue["submitReport"]>(
    ({ targetKind, targetId, targetLabel, reason, notes = "", blockSeller: blockOnSubmit = false, sellerName }) => {
      const now = new Date().toISOString();
      const report: SafetyReport = {
        id: `rep-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        targetKind,
        targetId,
        targetLabel,
        reason,
        notes,
        status: "submitted",
        createdAtIso: now,
        updatedAtIso: now,
        blockedAtSubmit: blockOnSubmit,
      };
      setReports((prev) => [report, ...prev]);
      if (blockOnSubmit && sellerName) {
        blockSeller(sellerName, reason);
      }
      // Synth: simulate review escalation after a tick by writing in_review state.
      setTimeout(() => {
        setReports((prev) =>
          prev.map((r) =>
            r.id === report.id
              ? { ...r, status: "in_review", updatedAtIso: new Date().toISOString() }
              : r,
          ),
        );
      }, 1500);
      return report;
    },
    [setReports, blockSeller],
  );

  const reset = useCallback(() => {
    setReports([]);
    setBlocked([]);
  }, [setReports, setBlocked]);

  const value = useMemo<SafetyContextValue>(
    () => ({
      reports,
      blocked,
      submitReport,
      blockSeller,
      unblockSeller,
      isBlocked,
      reset,
    }),
    [reports, blocked, submitReport, blockSeller, unblockSeller, isBlocked, reset],
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
