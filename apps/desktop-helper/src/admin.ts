// "Admin: allow everything": Ben's own switch, from the PC dashboard only. While it's on, every tool call is
// allowed, including the ones that are otherwise always refused (credentials, keys, the helper's own files).
// It always ends: after the chosen time, or when switched off. Phones and browsers can only switch it off.
import type { Config } from "./config.js";

export type AdminChoice = "1h" | "8h" | "until-off" | "off";
export const ADMIN_CHOICES: readonly AdminChoice[] = ["1h", "8h", "until-off", "off"];
const DURATION: Record<string, number> = { "1h": 3_600_000, "8h": 8 * 3_600_000 };

/** Stored value: 0 off, -1 until switched off, otherwise the time (epoch ms) it switches itself off. */
export function adminUntilFor(choice: AdminChoice, now = Date.now()): number {
  if (choice === "off") return 0;
  if (choice === "until-off") return -1;
  return now + DURATION[choice];
}

/** Whether it's on right now (an expired time counts as off even before the timer tidies it up). */
export function adminState(config: Pick<Config, "adminAllowUntil">, now = Date.now()): { on: boolean; until: number | null } {
  const u = Number(config.adminAllowUntil) || 0;
  if (u === -1) return { on: true, until: -1 };
  if (u > now) return { on: true, until: u };
  return { on: false, until: null };
}

/** True when a timed switch has run out and should be cleared (and announced). */
export function adminExpired(config: Pick<Config, "adminAllowUntil">, now = Date.now()) {
  const u = Number(config.adminAllowUntil) || 0;
  return u > 0 && u <= now;
}

/** What a phone or browser asked for: only "off" is accepted; anything that would turn it on is refused. */
export function deviceAdminRequest(value: unknown): "off" | "refuse" | null {
  if (value === undefined || value === null) return null;
  return value === false || value === "off" ? "off" : "refuse";
}
