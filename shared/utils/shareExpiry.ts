export type ShareExpiryPreset = "never" | "1h" | "1d" | "7d" | "30d" | "custom";

export const DEFAULT_SHARE_EXPIRY_DAYS = 1;
export const MAX_SHARE_EXPIRY_DAYS = 30;
const dayMilliseconds = 24 * 60 * 60 * 1000;

const presetMilliseconds: Partial<Record<ShareExpiryPreset, number>> = {
  "1h": 60 * 60 * 1000,
  "1d": dayMilliseconds,
  "7d": 7 * dayMilliseconds,
  "30d": MAX_SHARE_EXPIRY_DAYS * dayMilliseconds,
};

export function getDefaultShareExpiryDate(now = new Date()): Date {
  return new Date(now.getTime() + DEFAULT_SHARE_EXPIRY_DAYS * dayMilliseconds);
}

export function isShareExpiryWithinLimit(
  expiresAt: Date,
  now = new Date()
): boolean {
  return (
    expiresAt.getTime() <=
    now.getTime() + MAX_SHARE_EXPIRY_DAYS * dayMilliseconds
  );
}

/** Resolve a share expiration preset to an absolute date. */
export function getShareExpiryDate(
  preset: ShareExpiryPreset,
  now = new Date(),
  customDate?: Date
): Date | null {
  if (preset === "never") {
    return null;
  }
  if (preset === "custom") {
    return customDate ?? null;
  }

  const milliseconds = presetMilliseconds[preset];
  return milliseconds ? new Date(now.getTime() + milliseconds) : null;
}
