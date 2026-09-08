import { findRibbonHeaderMenu } from "./TableDocumentLayout";

describe("findRibbonHeaderMenu", () => {
  it("returns the confirmed Univer ribbon header containing the direct tablist", () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <div role="tablist"></div>
      <div data-u-comp="ribbon-header-menu">
        <div role="tablist"><button role="tab">开始</button></div>
      </div>
    `;

    expect(findRibbonHeaderMenu(container)).toBe(
      container.querySelector('[data-u-comp="ribbon-header-menu"]')
    );
  });

  it("does not target a nested or unrelated tablist", () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <div data-u-comp="ribbon-header-menu">
        <div><div role="tablist"></div></div>
      </div>
    `;

    expect(findRibbonHeaderMenu(container)).toBeNull();
  });
});
