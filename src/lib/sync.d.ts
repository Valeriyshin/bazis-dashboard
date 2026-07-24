/** Синкает один или несколько аккаунтов Meta (см. FB_AD_ACCOUNT_IDS) и объединяет их в одну сводку. */
export function runSync(opts?: {
  since?: string;
  until?: string;
  days?: number;
}): Promise<{
  snapshotId: number;
  since: string;
  until: string;
  days: number;
  campaigns: number;
  adsets: number;
  ads: number;
}>;
