import path from "node:path";

/**
 * Where a resource's directory came from, kept as the facts a refusal
 * needs to tell the operator what to change: the setting that chose the
 * directory, the value as it was written, the directory a relative value
 * was resolved against, and the setting that moves the directory — or that
 * none does.
 *
 * A producer builds the directory and its location together, with the
 * constructors below, so the two cannot disagree: the path is computed
 * from the same value and base the location records. Nothing here words a
 * message; `ResourcePreflightRefusedError` does that from a location and
 * the access that was denied.
 */

/**
 * A setting, named as the operator would look for it in order to change
 * it: a bare variable name for a variable of the owner's own environment
 * (`CODEX_HOME`), and qualified wherever the name alone would send them to
 * the wrong place — a variable the launcher reads from its own environment
 * while the engine has one of the same name, a key in a named file
 * (`run_record.dir in /home/someone/.config/ensemble/config.json`), a
 * library option. A name is one setting: where several would move the
 * directory, it is the one that outranks the others.
 */
export type SettingName = string;

/** One setting's value, as written, and what it was resolved against. */
export interface SettingReading {
  setting: SettingName;
  /** The value exactly as the operator wrote it, relative where they wrote it relative. */
  value: string;
  /**
   * The directory a relative `value` was resolved against — the working
   * directory of the process that reads the setting, which differs between
   * the launcher, a shared engine server and a placed worker. Null when
   * `value` is absolute.
   */
  resolvedAgainst: string | null;
}

/**
 * How a resource's directory was chosen, which decides what moves it:
 *
 * - `declared` — a setting that places this resource is in force, and its
 *   value is the directory (or the directory's parent). Changing that
 *   setting moves it.
 * - `default` — no such setting is in force, so the directory follows
 *   `rule` (`$HOME/.codex`). `movedBy` is the setting that would place it;
 *   `from` is the reading the rule was computed from where it starts at
 *   another setting's value (`HOME`), so a relative one is still shown
 *   against its base.
 * - `fixed` — the resource's owner puts it at `rule` whatever is set
 *   (`/tmp/cc-daemon-<uid>/<config hash>`). No setting moves it: the only
 *   remedy is access to the directory itself.
 */
export type ResourceLocation =
  | { kind: "declared"; reading: SettingReading }
  | { kind: "default"; rule: string; movedBy: SettingName; from: SettingReading | null }
  | { kind: "fixed"; rule: string };

/** A directory with the account of how it was chosen. */
export interface LocatedDirectory {
  /** Absolute path of the directory. Need not exist yet. */
  path: string;
  location: ResourceLocation;
}

/**
 * Record a setting's value as written. `base` is the directory a relative
 * value resolves against for the process that reads this setting; pass it
 * whether or not `value` is relative.
 */
export function readSetting(setting: SettingName, value: string, base: string): SettingReading {
  return { setting, value, resolvedAgainst: path.isAbsolute(value) ? null : base };
}

/** The directory a setting in force names, or `below` under it. */
export function declaredDirectory(reading: SettingReading, ...below: string[]): LocatedDirectory {
  return { path: directoryOf(reading, below), location: { kind: "declared", reading } };
}

/**
 * The directory a default rule gives when the setting that would place it
 * (`movedBy`) is not in force: `below` under `root`. `root` is the reading
 * of the setting the rule starts from, or an absolute built-in path where
 * it starts from none.
 */
export function defaultDirectory(
  chosen: { rule: string; movedBy: SettingName },
  root: SettingReading | string,
  ...below: string[]
): LocatedDirectory {
  return typeof root === "string"
    ? { path: path.resolve(root, ...below), location: { kind: "default", ...chosen, from: null } }
    : { path: directoryOf(root, below), location: { kind: "default", ...chosen, from: root } };
}

/** A directory its owner fixes at `directory`, an absolute path, by `rule`. */
export function fixedDirectory(rule: string, directory: string): LocatedDirectory {
  return { path: path.resolve(directory), location: { kind: "fixed", rule } };
}

/** The setting an operator changes to move the directory, or null where none moves it. */
export function settingToChange(location: ResourceLocation): SettingName | null {
  switch (location.kind) {
    case "declared":
      return location.reading.setting;
    case "default":
      return location.movedBy;
    case "fixed":
      return null;
  }
}

function directoryOf(reading: SettingReading, below: readonly string[]): string {
  const base = reading.resolvedAgainst === null ? [] : [reading.resolvedAgainst];
  return path.resolve(...base, reading.value, ...below);
}
