import {
  getDefaultShareExpiryDate,
  getShareExpiryDate,
  isShareExpiryWithinLimit,
  MAX_SHARE_EXPIRY_DAYS,
} from "./shareExpiry";

describe("share expiry", () => {
  const now = new Date("2026-09-04T00:00:00.000Z");

  test("defaults to one day", () => {
    expect(getDefaultShareExpiryDate(now).toISOString()).toBe(
      "2026-09-05T00:00:00.000Z"
    );
  });

  test("allows no more than thirty days", () => {
    expect(MAX_SHARE_EXPIRY_DAYS).toBe(30);
    expect(
      isShareExpiryWithinLimit(new Date("2026-10-04T00:00:00.000Z"), now)
    ).toBe(true);
    expect(
      isShareExpiryWithinLimit(new Date("2026-10-05T00:00:00.000Z"), now)
    ).toBe(false);
  });

  test("never is not a valid public share expiry", () => {
    expect(getShareExpiryDate("never", now)).toBeNull();
  });
});
