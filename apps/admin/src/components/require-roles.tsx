import type { ReactNode } from "react";
import { useAdminMyRoles } from "@workspace/api-client-react";
import { ShieldAlert } from "lucide-react";

/**
 * Client-side route guard. Renders `children` only when the signed-in
 * operator holds at least one of the listed roles. The API is the source
 * of truth — this exists purely to avoid leaking page chrome and stop
 * accidental navigation to admin-only Trust & Safety surfaces.
 *
 * IMPORTANT: never trust client-side roles for authorization. Pair every
 * use of this with a matching `requireRole(...)` gate on the backend.
 */
export function RequireRoles({
  roles: requiredRoles,
  children,
}: {
  roles: readonly string[];
  children: ReactNode;
}) {
  const rolesQuery = useAdminMyRoles({
    query: { staleTime: 30_000 } as never,
  });
  const myRoles = rolesQuery.data?.roles ?? [];

  if (rolesQuery.isLoading) {
    return (
      <div
        data-testid="require-roles-loading"
        className="rounded-md border border-dashed border-muted-foreground/30 p-8 text-center text-sm text-muted-foreground"
      >
        Checking permissions…
      </div>
    );
  }

  const ok = requiredRoles.some((r) => myRoles.includes(r));
  if (!ok) {
    return (
      <div
        data-testid="require-roles-forbidden"
        className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm"
      >
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
        <div className="min-w-0">
          <p className="font-medium text-destructive">Restricted to admins</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This page is part of the Trust &amp; Safety surface and is only
            visible to operators holding the <code>admin</code> role. Ask an
            existing admin to grant you access from the Users &amp; roles page.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
