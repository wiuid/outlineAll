import TextColor, { semanticTextColors } from "./TextColor";

describe("TextColor palette", () => {
  test("provides light and dark variants for eight color families", () => {
    expect(semanticTextColors).toHaveLength(16);
    for (const family of [
      "red",
      "orange",
      "yellow",
      "green",
      "cyan",
      "blue",
      "purple",
      "gray",
    ]) {
      expect(TextColor.isSupported(`light-${family}`)).toBe(true);
      expect(TextColor.isSupported(`dark-${family}`)).toBe(true);
    }
  });

  test("keeps colors semantic instead of storing raw theme-specific values", () => {
    expect(semanticTextColors.every((color) => color.value.includes("-"))).toBe(
      true
    );
    expect(semanticTextColors.map((color) => color.preview)).not.toContain(
      "#A7F3D0"
    );
  });
});
