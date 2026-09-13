import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import {
  formatTableScriptCronValues,
  getTableScriptCronFieldRule,
  getTableScriptCronFields,
  getTableScriptCronPeriod,
  setTableScriptCronPeriod,
  tableScriptCronRanges,
  updateTableScriptCron,
  type TableScriptCronFields,
  type TableScriptCronPeriod,
} from "~/utils/tableScriptCron";

interface Props {
  value: string;
  onChange: (value: string) => void;
}

interface Choice {
  value: string;
  label: string;
}

/**
 * Edits common schedules and individual cron fields through visual controls.
 *
 * @param props the expression and an explicit local-draft change handler.
 * @returns a picker that preserves saved syntax until the user edits it.
 */
export function TableScriptCronPicker({ value, onChange }: Props) {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const [custom, setCustom] = useState(false);
  const fields = getTableScriptCronFields(value);
  const period = custom ? "custom" : getTableScriptCronPeriod(value);
  const periods: { value: TableScriptCronPeriod; label: string }[] = [
    { value: "minutes", label: zh ? "按分钟" : t("Every few minutes") },
    { value: "hours", label: zh ? "按小时" : t("Every few hours") },
    { value: "daily", label: zh ? "每天" : t("Daily") },
    { value: "weekly", label: zh ? "每周" : t("Weekly") },
    { value: "monthly", label: zh ? "每月" : t("Monthly") },
    { value: "custom", label: zh ? "自定义" : t("Custom") },
  ];
  const labels: Record<keyof TableScriptCronFields, string> = {
    minute: zh ? "分钟" : t("Minute"),
    hour: zh ? "小时" : t("Hour"),
    dayOfMonth: zh ? "日期" : t("Day of month"),
    month: zh ? "月份" : t("Month"),
    dayOfWeek: zh ? "星期" : t("Day of week"),
  };
  const options = useMemo(() => {
    const weekday = new Intl.DateTimeFormat(i18n.language, {
      weekday: "short",
      timeZone: "UTC",
    });
    const month = new Intl.DateTimeFormat(i18n.language, {
      month: "short",
      timeZone: "UTC",
    });
    return {
      minute: numberChoices(0, 59, true),
      hour: numberChoices(0, 23, true),
      dayOfMonth: [
        ...numberChoices(1, 31),
        { value: "L", label: zh ? "月末" : t("Last day") },
      ],
      month: numberChoices(1, 12).map((option) => ({
        ...option,
        label: month.format(
          new Date(Date.UTC(2026, Number(option.value) - 1, 1))
        ),
      })),
      dayOfWeek: [1, 2, 3, 4, 5, 6, 0].map((day) => ({
        value: String(day),
        label: weekday.format(new Date(Date.UTC(2023, 0, day + 1))),
      })),
    };
  }, [i18n.language, t, zh]);
  const handleFieldChange = (changes: Partial<TableScriptCronFields>) =>
    onChange(updateTableScriptCron(value, changes));

  return (
    <Picker aria-label={zh ? "执行规则" : t("Schedule rule")}>
      <Controls>
        <ChoiceSelect
          label={zh ? "执行周期" : t("Repeat")}
          value={period}
          options={periods}
          onChange={(next) => {
            const selected = periods.find((option) => option.value === next);
            if (!selected) {
              return;
            }
            setCustom(selected.value === "custom");
            const nextValue = setTableScriptCronPeriod(value, selected.value);
            if (nextValue !== value) {
              onChange(nextValue);
            }
          }}
        />
        {fields && (period === "minutes" || period === "hours") && (
          <ChoiceSelect
            label={zh ? "间隔" : t("Interval")}
            value={String(
              getTableScriptCronFieldRule(
                period === "minutes" ? "minute" : "hour",
                period === "minutes" ? fields.minute : fields.hour
              ).interval
            )}
            options={numberChoices(1, period === "minutes" ? 60 : 24).map(
              (option) => ({
                ...option,
                label:
                  period === "minutes"
                    ? zh
                      ? `${option.value} 分钟`
                      : t("{{count}} minutes", { count: Number(option.value) })
                    : zh
                      ? `${option.value} 小时`
                      : t("{{count}} hours", { count: Number(option.value) }),
              })
            )}
            onChange={(interval) =>
              handleFieldChange({
                [period === "minutes" ? "minute" : "hour"]:
                  interval === "1" ? "*" : `*/${interval}`,
              })
            }
          />
        )}
        {fields && ["daily", "weekly", "monthly"].includes(period) && (
          <ChoiceSelect
            label={labels.hour}
            value={String(Number(fields.hour))}
            options={options.hour}
            onChange={(hour) => handleFieldChange({ hour })}
          />
        )}
        {fields && !["minutes", "custom"].includes(period) && (
          <ChoiceSelect
            label={labels.minute}
            value={String(Number(fields.minute))}
            options={options.minute}
            onChange={(minute) => handleFieldChange({ minute })}
          />
        )}
      </Controls>
      {period === "minutes" && (
        <Hint>
          {zh
            ? "从每小时的 00 分开始，按所选间隔执行。"
            : t("Repeats within each hour, starting at minute 00.")}
        </Hint>
      )}
      {period === "hours" && (
        <Hint>
          {zh
            ? "从每天的 00 时开始，按所选间隔和分钟执行。"
            : t(
                "Repeats within each day, starting at hour 00, at the selected minute."
              )}
        </Hint>
      )}
      {fields && period === "weekly" && (
        <ValueChoices
          label={zh ? "执行星期（可多选）" : t("Days of the week")}
          values={
            getTableScriptCronFieldRule("dayOfWeek", fields.dayOfWeek).values
          }
          options={options.dayOfWeek}
          onChange={(values) =>
            handleFieldChange({
              dayOfWeek: formatTableScriptCronValues(values),
            })
          }
        />
      )}
      {fields && period === "monthly" && (
        <>
          <ValueChoices
            label={zh ? "执行日期（可多选）" : t("Days of the month")}
            values={
              getTableScriptCronFieldRule("dayOfMonth", fields.dayOfMonth)
                .values
            }
            options={options.dayOfMonth}
            onChange={(values) =>
              handleFieldChange({
                dayOfMonth: formatTableScriptCronValues(values),
              })
            }
          />
          <Hint>
            {zh
              ? "没有所选日期的月份会跳过该日期；“月末”始终为当月最后一天。"
              : t(
                  "Dates missing from a month are skipped. Last day always uses the end of that month."
                )}
          </Hint>
        </>
      )}
      {period === "custom" && fields && (
        <>
          <Hint>
            {zh
              ? "展开各项，选择指定值、间隔或范围。"
              : t("Expand a field to select values, an interval, or a range.")}
          </Hint>
          {fieldNames.map((field) => (
            <FieldEditor
              key={field}
              field={field}
              label={labels[field]}
              value={fields[field]}
              options={options[field]}
              onChange={(next) => handleFieldChange({ [field]: next })}
            />
          ))}
          {fields.dayOfMonth !== "*" &&
            fields.dayOfMonth !== "?" &&
            fields.dayOfWeek !== "*" &&
            fields.dayOfWeek !== "?" &&
            !fields.dayOfWeek.includes("#") && (
              <Hint>
                {zh
                  ? "日期与星期同时指定时，满足其中一项即可执行；月份仍须匹配。"
                  : t(
                      "When both date and weekday are specified, either can match. The month must still match."
                    )}
              </Hint>
            )}
        </>
      )}
      <Expression>
        <span>{zh ? "Cron 表达式" : t("Cron expression")}</span>
        <output aria-label={zh ? "Cron 表达式" : t("Cron expression")}>
          <code>{value}</code>
        </output>
      </Expression>
    </Picker>
  );
}

const fieldNames: (keyof TableScriptCronFields)[] = [
  "minute",
  "hour",
  "dayOfMonth",
  "month",
  "dayOfWeek",
];

function numberChoices(min: number, max: number, pad = false): Choice[] {
  return Array.from({ length: max - min + 1 }, (_, index) => ({
    value: String(index + min),
    label: pad ? String(index + min).padStart(2, "0") : String(index + min),
  }));
}

interface ChoiceSelectProps {
  label: string;
  value: string;
  options: Choice[];
  onChange: (value: string) => void;
}

function ChoiceSelect({ label, value, options, onChange }: ChoiceSelectProps) {
  const labelId = useId();
  return (
    <Label>
      <span id={labelId}>{label}</span>
      <Select
        aria-labelledby={labelId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </Label>
  );
}

interface ValueChoicesProps {
  label: string;
  values: string[];
  options: Choice[];
  onChange: (values: string[]) => void;
}

function ValueChoices({ label, values, options, onChange }: ValueChoicesProps) {
  return (
    <Group>
      <legend>{label}</legend>
      <Choices $columns={options.length === 7 ? 7 : 8}>
        {options.map((option) => {
          const selected = values.includes(option.value);
          return (
            <ChoiceButton
              key={option.value}
              type="button"
              aria-pressed={selected}
              disabled={selected && values.length === 1}
              onClick={() =>
                onChange(
                  selected
                    ? values.filter((value) => value !== option.value)
                    : [...values, option.value]
                )
              }
            >
              {option.label}
            </ChoiceButton>
          );
        })}
      </Choices>
    </Group>
  );
}

interface FieldEditorProps extends ChoiceSelectProps {
  field: keyof TableScriptCronFields;
}

function FieldEditor({
  field,
  label,
  value,
  options,
  onChange,
}: FieldEditorProps) {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const rule = getTableScriptCronFieldRule(field, value);
  const [selectValues, setSelectValues] = useState(false);
  const mode = selectValues && rule.values.length ? "values" : rule.mode;
  const { min, max } = tableScriptCronRanges[field];
  const numbers = options.filter((option) => option.value !== "L");
  const modes: Choice[] = [
    { value: "every", label: zh ? "每一个" : t("Every value") },
    { value: "values", label: zh ? "指定值" : t("Selected values") },
    { value: "interval", label: zh ? "间隔" : t("Interval") },
    { value: "range", label: zh ? "范围" : t("Range") },
  ];
  if (rule.mode === "preserved") {
    modes.push({
      value: "preserved",
      label: zh ? "保留现有规则" : t("Keep existing rule"),
    });
  }
  return (
    <FieldDetails>
      <summary>
        {label}
        <code>{value}</code>
      </summary>
      <FieldContent>
        <Controls>
          <ChoiceSelect
            label={zh ? `${label}规则` : t("{{field}} rule", { field: label })}
            value={mode}
            options={modes}
            onChange={(nextMode) => {
              setSelectValues(nextMode === "values");
              switch (nextMode) {
                case "every":
                  onChange("*");
                  break;
                case "values":
                  onChange(String(min));
                  break;
                case "interval":
                  onChange("*/2");
                  break;
                case "range":
                  onChange(`${min}-${max}`);
                  break;
              }
            }}
          />
          {(mode === "interval" || mode === "range") && (
            <ChoiceSelect
              label={zh ? "从" : t("From")}
              value={String(rule.start)}
              options={numbers}
              onChange={(start) =>
                onChange(
                  mode === "interval"
                    ? `${start}/${rule.interval}`
                    : `${start}-${Math.max(Number(start), rule.end)}`
                )
              }
            />
          )}
          {mode === "interval" && (
            <ChoiceSelect
              label={zh ? "每隔" : t("Every")}
              value={String(rule.interval)}
              options={numberChoices(1, max - min + 1)}
              onChange={(interval) => onChange(`${rule.start}/${interval}`)}
            />
          )}
          {mode === "range" && (
            <ChoiceSelect
              label={zh ? "至" : t("Through")}
              value={String(rule.end)}
              options={numbers.filter(
                (option) => Number(option.value) >= rule.start
              )}
              onChange={(end) => onChange(`${rule.start}-${end}`)}
            />
          )}
        </Controls>
        {(mode === "values" || mode === "range") && (
          <ValueChoices
            label={
              zh
                ? `${label}（可多选）`
                : t("Select {{field}}", { field: label })
            }
            values={rule.values}
            options={options}
            onChange={(values) => {
              setSelectValues(true);
              onChange(formatTableScriptCronValues(values));
            }}
          />
        )}
        {rule.mode === "preserved" && (
          <Hint>
            {zh
              ? "现有规则已保留。选择其他规则类型后才会替换此项。"
              : t(
                  "The existing rule is preserved until you select another rule type."
                )}
          </Hint>
        )}
      </FieldContent>
    </FieldDetails>
  );
}

const Picker = styled.section`
  display: flex;
  flex-direction: column;
  gap: 12px;
`;
const Controls = styled.div`
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 12px;
`;
const Label = styled.label`
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 80px;
`;
const Select = styled.select`
  min-height: 34px;
  padding: 6px 28px 6px 8px;
  color: ${({ theme }) => theme.text};
  background: ${({ theme }) => theme.background};
  border: 1px solid ${({ theme }) => theme.inputBorder};
  border-radius: 5px;
  font: inherit;
  color-scheme: ${({ theme }) => (theme.isDark ? "dark" : "light")};
  &:focus-visible {
    outline: 2px solid ${({ theme }) => theme.inputBorderFocused};
    outline-offset: 2px;
  }
`;
const Group = styled.fieldset`
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
  legend {
    padding: 0;
    margin-bottom: 8px;
  }
`;
const Choices = styled.div<{ $columns: number }>`
  display: grid;
  grid-template-columns: repeat(${({ $columns }) => $columns}, minmax(0, 1fr));
  gap: 6px;
  max-width: 480px;
`;
const ChoiceButton = styled.button`
  min-height: 32px;
  padding: 4px;
  border: 1px solid ${({ theme }) => theme.inputBorder};
  border-radius: 5px;
  color: ${({ theme }) => theme.textSecondary};
  background: ${({ theme }) => theme.background};
  font: inherit;
  cursor: var(--pointer);
  &[aria-pressed="true"] {
    color: ${({ theme }) => theme.accent};
    border-color: ${({ theme }) => theme.accent};
    background: ${({ theme }) => theme.backgroundSecondary};
    font-weight: 600;
  }
  &:hover {
    background: ${({ theme }) => theme.backgroundSecondary};
  }
  &:focus-visible {
    outline: 2px solid ${({ theme }) => theme.inputBorderFocused};
    outline-offset: 2px;
  }
`;
const Hint = styled.div`
  color: ${({ theme }) => theme.textSecondary};
  font-size: 12px;
  line-height: 1.5;
`;
const Expression = styled.div`
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  color: ${({ theme }) => theme.textSecondary};
  font-size: 12px;
  code {
    color: ${({ theme }) => theme.text};
    overflow-wrap: anywhere;
  }
`;
const FieldDetails = styled.details`
  border: 1px solid ${({ theme }) => theme.divider};
  border-radius: 5px;
  summary {
    padding: 8px 10px;
    cursor: var(--pointer);
  }
  code {
    margin-inline-start: 12px;
    color: ${({ theme }) => theme.textSecondary};
    overflow-wrap: anywhere;
  }
`;
const FieldContent = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 10px 12px;
`;
