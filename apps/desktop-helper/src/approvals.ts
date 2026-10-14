// Approvals and questions: send a request to the devices that sent the turn (phone by voice, or the browser),
// wait for the answer or time out (deny / no answer).
import { randomBytes } from "node:crypto";
import type { AskQuestion, ConfirmDecision } from "@claude-anywhere/protocol";
import { broadcast, connectedCount, connectedCountFor, onConnectionChange, type Audience } from "./hub.js";

type ConfirmResult = { decision: ConfirmDecision; heard: string; by: "phone" | "server" };

interface Pending {
  resolve: (r: ConfirmResult) => void;
  timer: NodeJS.Timeout;
  turnId: string;
}
const pending = new Map<string, Pending>();

export interface ConfirmArgs {
  turnId: string;
  tier: 1 | 2;
  summary: string;
  command: string;
  verb: string;
  timeoutS: number;
  /** Who is asked. Default: phones (spoken confirmation). */
  to?: Audience;
  /** Shown in full by browsers. */
  sessionId?: string;
  tool?: string;
  toolUseId?: string;
  input?: unknown;
}

export function requestConfirmation(a: ConfirmArgs): Promise<ConfirmResult> {
  const to = a.to ?? "phone";
  if (connectedCountFor(to) === 0) return Promise.resolve({ decision: "timeout", heard: "", by: "server" });
  const confirmId = `c_${randomBytes(6).toString("base64url")}`;
  const phrase = `confirm ${a.verb || "run"}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle(confirmId, "timeout", "", "server"), a.timeoutS * 1000);
    pending.set(confirmId, { resolve, timer, turnId: a.turnId });
    broadcast(
      "confirm.request",
      {
        confirmId,
        turnId: a.turnId,
        tier: a.tier,
        summary: a.summary.charAt(0).toUpperCase() + a.summary.slice(1),
        command: a.command.slice(0, 2000),
        phrase,
        expiresInS: a.timeoutS,
        ...(to === "browser" ? { sessionId: a.sessionId, tool: a.tool, toolUseId: a.toolUseId, input: a.input } : {}),
      },
      to,
    );
  });
}

function settle(confirmId: string, decision: ConfirmDecision, heard: string, by: "phone" | "server") {
  const p = pending.get(confirmId);
  if (!p) return false;
  pending.delete(confirmId);
  clearTimeout(p.timer);
  broadcast("confirm.resolved", { confirmId, decision, by });
  p.resolve({ decision, heard, by });
  return true;
}

export function answerConfirmation(confirmId: string, decision: ConfirmDecision, heard: string) {
  return settle(confirmId, decision === "confirm" ? "confirm" : decision === "timeout" ? "timeout" : "cancel", heard, "phone");
}

// ---- questions (Claude's ask_user tool; browsers only) ----

interface PendingAsk {
  resolve: (answers: Record<string, string> | null) => void;
  timer: NodeJS.Timeout;
  turnId: string;
}
const asks = new Map<string, PendingAsk>();

/** Resolves with the chosen answers, or null if skipped, timed out, cancelled or no browser is connected. */
export function requestAnswers(a: { turnId: string; sessionId: string; questions: AskQuestion[]; timeoutS: number }): Promise<Record<string, string> | null> {
  if (connectedCountFor("browser") === 0) return Promise.resolve(null);
  const askId = `q_${randomBytes(6).toString("base64url")}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => settleAsk(askId, null), a.timeoutS * 1000);
    asks.set(askId, { resolve, timer, turnId: a.turnId });
    broadcast("ask.request", { askId, turnId: a.turnId, sessionId: a.sessionId, questions: a.questions, expiresInS: a.timeoutS });
  });
}

export function settleAsk(askId: string, answers: Record<string, string> | null) {
  const p = asks.get(askId);
  if (!p) return false;
  asks.delete(askId);
  clearTimeout(p.timer);
  broadcast("ask.resolved", { askId, answered: answers !== null });
  p.resolve(answers);
  return true;
}

/** Deny everything pending (kill switch, turn cancelled, everyone gone). */
export function denyAll(turnId?: string) {
  for (const [id, p] of pending) if (!turnId || p.turnId === turnId) settle(id, "cancel", "", "server");
  for (const [id, p] of asks) if (!turnId || p.turnId === turnId) settleAsk(id, null);
}

// Approvals are never queued offline: if the last device disconnects, deny what's pending.
onConnectionChange(() => {
  if (connectedCount() === 0) denyAll();
});
