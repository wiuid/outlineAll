import { createInstance } from "i18next";
import { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { ThemeProvider } from "styled-components";
import { buildLightTheme } from "@shared/styles/theme";
import { TableScriptCronPicker } from "./TableScriptCronPicker";

const cleanups = new Set<() => void>();

async function mountPicker(initial: string) {
  const onChange = vi.fn<(value: string) => void>();
  const i18n = createInstance();
  await i18n.init({ lng: "zh", resources: { zh: { translation: {} } } });
  function ControlledPicker() {
    const [value, setValue] = useState(initial);
    return (
      <TableScriptCronPicker
        value={value}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.add(() => {
    root.unmount();
    container.remove();
  });
  await act(async () => {
    root.render(
      <StrictMode>
        <I18nextProvider i18n={i18n}>
          <ThemeProvider theme={buildLightTheme({})}>
            <ControlledPicker />
          </ThemeProvider>
        </I18nextProvider>
      </StrictMode>
    );
  });
  const select = (label: string, scope: ParentNode = container) => {
    const element = [...scope.querySelectorAll("label")]
      .find((item) => item.firstChild?.textContent === label)
      ?.querySelector("select");
    if (!element) {
      throw new Error(`Missing select: ${label}`);
    }
    return element;
  };
  const choose = async (
    label: string,
    value: string,
    scope: ParentNode = container
  ) => {
    await act(async () => {
      const element = select(label, scope);
      element.value = value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  const click = async (name: string, scope: ParentNode = container) => {
    const button = [...scope.querySelectorAll("button")].find(
      (item) => item.textContent === name
    );
    if (!button) {
      throw new Error(`Missing button: ${name}`);
    }
    await act(async () => button.click());
    return button;
  };
  const expression = () => container.querySelector("output")?.textContent;
  return { container, onChange, select, choose, click, expression };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
    cleanups.clear();
  });
  vi.unstubAllGlobals();
});

it("opens a saved complex rule without editing it or exposing a cron text input", async () => {
  const cron = "0/15 9-17 * JAN-MAR MON-FRI";
  const picker = await mountPicker(cron);
  expect(picker.select("执行周期").value).toBe("custom");
  expect(picker.expression()).toBe(cron);
  expect(picker.onChange).not.toHaveBeenCalled();
  expect(picker.container.querySelectorAll("input, textarea")).toHaveLength(0);
  await picker.choose("小时规则", "values");
  expect(picker.expression()).toBe("0/15 0 * JAN-MAR MON-FRI");
});

it("selects multiple weekdays while preventing an empty schedule", async () => {
  const picker = await mountPicker("30 9 * * *");
  await picker.choose("执行周期", "weekly");
  await picker.click("周三");
  expect(picker.expression()).toBe("30 9 * * 1,3");
  await picker.click("周一");
  expect(picker.expression()).toBe("30 9 * * 3");
  const remaining = await picker.click("周三");
  expect(remaining.disabled).toBe(true);
  expect(picker.expression()).toBe("30 9 * * 3");
});

it("selects month end and retains it when adjusting execution time", async () => {
  const picker = await mountPicker("0 9 * * *");
  await picker.choose("执行周期", "monthly");
  await picker.click("月末");
  await picker.click("1");
  await picker.choose("小时", "18");
  await picker.choose("分钟", "45");
  expect(picker.expression()).toBe("45 18 L * *");
});

it("keeps the selected-values editor open when adjacent choices compress to a range", async () => {
  const picker = await mountPicker("0 9 * * *");
  await picker.choose("执行周期", "custom");
  expect(picker.onChange).not.toHaveBeenCalled();
  const minute = picker.container.querySelector("details");
  if (!minute) {
    throw new Error("Missing minute editor");
  }
  await picker.choose("分钟规则", "values", minute);
  await picker.click("01", minute);
  await picker.click("02", minute);
  expect(picker.select("分钟规则", minute).value).toBe("values");
  expect(picker.expression()).toBe("0-2 9 * * *");
  await picker.click("01", minute);
  expect(picker.expression()).toBe("0,2 9 * * *");
  expect(picker.select("执行周期").value).toBe("custom");
});
