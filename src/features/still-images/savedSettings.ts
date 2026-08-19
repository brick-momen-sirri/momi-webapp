// Reading a saved settings bag back into the form.
//
// Two things restore a preset's settings from outside the form: Reuse settings,
// which reads them off a job, and the persisted panel state, which reads them out
// of browser storage after a reload. Neither source can be trusted to still match
// the catalogue -- a job recorded before a range narrowed, or a bag stored by a
// build whose select still had an option since removed, would put a value into the
// form that the server refuses the moment Generate is pressed.
//
// Shared rather than written twice so the two paths cannot disagree about what is
// still acceptable, which would mean a stored value surviving a reload that Reuse
// settings would have thrown away.

import type { StillImageCategoryDefinition, StillImageSettingDefinition, StillImageSettingValue } from "./stillImageCategories";

/**
 * Every setting the preset has, taking the saved value where it is still valid and
 * the catalogue default where it is not.
 *
 * Complete on purpose: the form draws from this map, and a missing key would render
 * a slider with no value rather than the default the artist would expect.
 */
export function stillImageSettingsFromSaved(
  category: StillImageCategoryDefinition,
  saved: Record<string, unknown> | undefined,
): Record<string, StillImageSettingValue> {
  const settings: Record<string, StillImageSettingValue> = {};
  for (const setting of category.settings) {
    settings[setting.id] = stillImageSettingValueFromSaved(setting, saved?.[setting.id]) ?? setting.defaultValue;
  }
  return settings;
}

/** The saved value if the catalogue still accepts it, otherwise undefined. */
export function stillImageSettingValueFromSaved(
  setting: StillImageSettingDefinition,
  value: unknown,
): StillImageSettingValue | undefined {
  if (setting.kind === "checkbox") {
    return typeof value === "boolean" ? value : undefined;
  }

  if (setting.kind === "select") {
    return typeof value === "string" && setting.options?.some((option) => option.value === value) ? value : undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const minimum = setting.minimum ?? Number.NEGATIVE_INFINITY;
  const maximum = setting.maximum ?? Number.POSITIVE_INFINITY;
  return value >= minimum && value <= maximum ? value : undefined;
}
