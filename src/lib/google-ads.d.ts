export function runGoogleAdsSync(opts?: {
  since?: string;
  until?: string;
  days?: number;
}): Promise<{
  snapshotId: number;
  since: string;
  until: string;
  days: number;
  campaigns: number;
}>;
