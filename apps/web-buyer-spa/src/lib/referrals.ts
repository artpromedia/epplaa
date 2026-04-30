// Static referral reward constants and seed activity used by the referrals
// hub. The signed-in user's invite code comes from the API
// (`useGetMyReferrals`); these constants are only used for display copy and
// the demo activity feed.

export interface ReferralActivity {
  id: string;
  inviteeHandle: string;
  status: "joined" | "first_purchase" | "rewarded";
  rewardMinor: number;
  atIso: string;
}

export const SEED_REFERRAL_ACTIVITY: ReferralActivity[] = [
  {
    id: "ref-1",
    inviteeHandle: "@nkechi.j",
    status: "rewarded",
    rewardMinor: 100000, // 1,000 NGN
    atIso: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "ref-2",
    inviteeHandle: "@samee.live",
    status: "first_purchase",
    rewardMinor: 50000,
    atIso: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "ref-3",
    inviteeHandle: "@adaeze_k",
    status: "joined",
    rewardMinor: 0,
    atIso: new Date(Date.now() - 28 * 60 * 60 * 1000).toISOString(),
  },
];

export const REFERRAL_REWARDS = {
  inviteeJoinedMinor: 0,
  firstPurchaseMinor: 50000, // 500 NGN credit on friend's first order
  rewardMinor: 100000, // 1,000 NGN credit when friend hits N50k spend
  monthlyCapMinor: 5000000, // 50,000 NGN cap
};

export function generateReferralCode(seed?: string): string {
  const base = (seed ?? `${Date.now()}`)
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase()
    .slice(-4);
  return `EPP-${base.padStart(4, "0")}`;
}

export function buildShareLink(code: string): string {
  return `https://epplaa.app/i/${code}`;
}
