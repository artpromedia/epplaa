import { useCallback, useMemo } from "react";
import {
  useGetNotificationPrefs,
  usePutNotificationPrefs,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export interface NotificationPrefs {
  liveDrops: boolean;
  orderUpdates: boolean;
  marketing: boolean;
  whatsapp: boolean;
  sms: boolean;
  whatsappNumber?: string;
  smsNumber?: string;
}

export const DEFAULT_NOTIFICATIONS: NotificationPrefs = {
  liveDrops: true,
  orderUpdates: true,
  marketing: false,
  whatsapp: true,
  sms: false,
  whatsappNumber: "",
  smsNumber: "",
};

/**
 * Mirrors the previous `useLocalStorage("epplaa-notifications", ...)` hook
 * shape so existing callers keep working, but sources of truth now live in
 * Postgres via the notification-prefs router.
 */
export function useNotificationPrefs(): [
  NotificationPrefs,
  (updater: NotificationPrefs | ((prev: NotificationPrefs) => NotificationPrefs)) => void,
] {
  const query = useGetNotificationPrefs();
  const qc = useQueryClient();
  const putMut = usePutNotificationPrefs({
    mutation: {
      onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/notification-prefs"] }),
    },
  });

  const prefs = useMemo<NotificationPrefs>(
    () => ({ ...DEFAULT_NOTIFICATIONS, ...((query.data ?? {}) as Partial<NotificationPrefs>) }),
    [query.data],
  );

  const setPrefs = useCallback(
    (updater: NotificationPrefs | ((prev: NotificationPrefs) => NotificationPrefs)) => {
      const next = typeof updater === "function" ? (updater as (p: NotificationPrefs) => NotificationPrefs)(prefs) : updater;
      qc.setQueryData(["/api/notification-prefs"], next);
      putMut.mutate({ data: next });
    },
    [prefs, putMut, qc],
  );

  return [prefs, setPrefs];
}
