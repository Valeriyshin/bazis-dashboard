export function getPeriodRate(
  since: string,
  until: string
): Promise<{
  rate: number;
  months: { month: string; rate: number; days: number }[];
  fallback: boolean;
}>;
