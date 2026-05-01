import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/clerk-react";

/**
 * Studio dashboard placeholder. Phase 8 of the v4.2 amendment will fill
 * this in by extracting these surfaces out of apps/web-buyer-spa:
 *
 *   - Go-live console
 *   - Replay manager
 *   - Earnings & payouts
 *   - Catalog / listings
 *
 * Until extraction lands, this page only renders the auth shell so the
 * app builds and the deploy substrate (Helm chart, Cloudflare Tunnel
 * route) has something to host.
 */

export function Dashboard() {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <header className="flex items-center justify-between px-6 py-4 border-b bg-white">
        <h1 className="text-lg font-semibold">Epplaa Studio</h1>
        <SignedIn>
          <UserButton />
        </SignedIn>
        <SignedOut>
          <SignInButton mode="modal" />
        </SignedOut>
      </header>
      <main className="p-6">
        <SignedIn>
          <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card title="Go live" subtitle="Coming in Phase 8" />
            <Card title="Replays" subtitle="Coming in Phase 8" />
            <Card title="Earnings" subtitle="Coming in Phase 8" />
          </section>
        </SignedIn>
        <SignedOut>
          <p className="text-sm text-zinc-600">Sign in to access seller tools.</p>
        </SignedOut>
      </main>
    </div>
  );
}

function Card({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <h2 className="font-medium">{title}</h2>
      <p className="text-sm text-zinc-500 mt-1">{subtitle}</p>
    </div>
  );
}
