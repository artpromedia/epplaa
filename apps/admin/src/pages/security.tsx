import { PageHeader } from "@/components/admin-shell";
import { MfaSetup } from "@/components/mfa-setup";

export default function SecurityPage() {
  return (
    <div data-testid="page-security">
      <PageHeader
        title="Account security"
        description="Multi-factor authentication keeps the back office safe. Operators are required to enrol."
      />
      <MfaSetup />
    </div>
  );
}
