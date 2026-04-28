import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAdminGetUserRoles,
  useAdminGrantUserRole,
  useAdminRevokeUserRole,
  getAdminGetUserRolesQueryKey,
} from "@workspace/api-client-react";
import { PageHeader } from "@/components/admin-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

const ROLES = ["admin", "moderator", "finance_ops", "support"];

export default function UsersPage() {
  const [userId, setUserId] = useState("");
  const [search, setSearch] = useState("");
  const [grantRole, setGrantRole] = useState<string>("moderator");
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading, error } = useAdminGetUserRoles(search, {
    query: { enabled: search.length > 0, staleTime: 5_000 } as never,
  });

  const grant = useAdminGrantUserRole({
    mutation: {
      onSuccess: () => {
        toast({ title: "Role granted" });
        qc.invalidateQueries({ queryKey: getAdminGetUserRolesQueryKey(search) });
      },
      onError: (e) => toast({ variant: "destructive", title: "Grant failed", description: String(e) }),
    },
  });
  const revoke = useAdminRevokeUserRole({
    mutation: {
      onSuccess: () => {
        toast({ title: "Role revoked" });
        qc.invalidateQueries({ queryKey: getAdminGetUserRolesQueryKey(search) });
      },
      onError: (e) => toast({ variant: "destructive", title: "Revoke failed", description: String(e) }),
    },
  });

  const roles = data?.roles ?? [];

  return (
    <div>
      <PageHeader
        title="Users &amp; roles"
        description="Look up an operator by user id and grant or revoke roles. Only admins can grant the admin role."
      />

      <Card className="mb-4">
        <CardHeader className="pb-2"><CardTitle className="text-sm">Lookup</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              placeholder="user id (Clerk subject)"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="font-mono text-xs"
              data-testid="input-user-id"
            />
            <Button onClick={() => setSearch(userId.trim())} data-testid="btn-lookup-user">
              Look up
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          Couldn't load roles for that user.
        </div>
      )}

      {search && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Roles for <span className="font-mono">{search}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : roles.length === 0 ? (
              <p className="text-xs text-muted-foreground">No roles assigned.</p>
            ) : (
              <div className="flex flex-wrap gap-2" data-testid="user-roles-list">
                {roles.map((r) => (
                  <Badge key={r} variant="outline" className="gap-2 pr-1">
                    {r}
                    <button
                      onClick={() => revoke.mutate({ userId: search, role: r })}
                      className="text-xs text-destructive hover:underline px-1"
                      data-testid={`btn-revoke-${r}`}
                      disabled={revoke.isPending}
                    >
                      revoke
                    </button>
                  </Badge>
                ))}
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-2 pt-2 border-t border-border">
              <div className="flex-1">
                <Label className="text-xs">Grant role</Label>
                <Select value={grantRole} onValueChange={setGrantRole}>
                  <SelectTrigger data-testid="select-grant-role"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <Button
                className="self-end"
                onClick={() => grant.mutate({ userId: search, data: { role: grantRole } })}
                disabled={grant.isPending}
                data-testid="btn-grant-role"
              >
                {grant.isPending ? "Saving…" : "Grant"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
