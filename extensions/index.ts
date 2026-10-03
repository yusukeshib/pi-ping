import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_TYPE = "pi-ping-state";
const DEFAULT_INTERVAL = 5 * 60_000;
const MAX_INTERVAL = 24 * 60 * 60_000;
const USAGE = "/ping enable [5m] | disable | interval <5m> | status";
const WAKE_MESSAGE =
  "[pi-ping automated wake-up] Check the existing user request and current state. " +
  "If authorized work remains unfinished, continue from where you stopped; " +
  "if a transient network error interrupted it, retry when possible. " +
  "Do not invent new work, repeat completed side effects, bypass approvals, or " +
  "ignore a request to stop. If finished or blocked on the user, report that briefly.";

type Settings = { enabled: boolean; intervalMs: number };

export function parseInterval(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/i.exec(value);
  if (!match) return undefined;
  const unit = match[2]?.toLowerCase() ?? "m";
  const ms = Number(match[1]) * ({ s: 1000, m: 60_000, h: 3_600_000 }[unit] ?? 0);
  return Number.isSafeInteger(ms) && ms >= 1000 && ms <= MAX_INTERVAL ? ms : undefined;
}

function isSettings(value: unknown): value is Settings {
  if (!value || typeof value !== "object") return false;
  const settings = value as Settings;
  return typeof settings.enabled === "boolean" &&
    Number.isSafeInteger(settings.intervalMs) &&
    settings.intervalMs >= 1000 && settings.intervalMs <= MAX_INTERVAL;
}

function formatInterval(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms / 1000}s`;
}

export default function ping(pi: ExtensionAPI) {
  let settings: Settings = { enabled: false, intervalMs: DEFAULT_INTERVAL };
  let context: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextPingAt: number | undefined;
  let dialogDepth = 0;
  let running = false;

  function updateStatus() {
    if (!context?.hasUI) return;
    context.ui.setStatus("pi-ping", settings.enabled
      ? `ping on · ${formatInterval(settings.intervalMs)}`
      : undefined);
  }

  function cancelTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    nextPingAt = undefined;
  }

  function schedule() {
    cancelTimer();
    if (!settings.enabled || !context || running) return;
    nextPingAt = Date.now() + settings.intervalMs;
    timer = setTimeout(tick, settings.intervalMs);
    timer.unref?.();
  }

  function tick() {
    timer = undefined;
    nextPingAt = undefined;
    const ctx = context;
    if (!settings.enabled || !ctx) return;
    try {
      if (running || !ctx.isIdle() || ctx.hasPendingMessages() || dialogDepth > 0 ||
        (ctx.mode === "tui" && ctx.ui.getEditorText().trim())) {
        schedule();
        return;
      }
      // No await between the idle check and delivery: never queue wake-ups while busy.
      pi.sendMessage({
        customType: "pi-ping",
        content: WAKE_MESSAGE,
        display: true,
        details: { intervalMs: settings.intervalMs },
      }, { triggerTurn: true });
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`pi-ping: ${String(error)}`, "error");
    } finally {
      // agent_start cancels this; agent_settled starts a fresh full interval.
      // Also handles preflight failures that never emit agent_start.
      schedule();
    }
  }

  function restore(ctx: ExtensionContext) {
    cancelTimer();
    context = ctx;
    settings = { enabled: false, intervalMs: DEFAULT_INTERVAL };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_TYPE && isSettings(entry.data)) {
        settings = { ...entry.data };
      }
    }
    running = !ctx.isIdle();
    dialogDepth = 0;
    updateStatus();
    schedule();
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => {
    cancelTimer();
    if (context?.hasUI) context.ui.setStatus("pi-ping", undefined);
    context = undefined;
    settings.enabled = false;
    running = false;
    dialogDepth = 0;
  });
  pi.on("agent_start", (_event, ctx) => {
    context = ctx;
    running = true;
    cancelTimer();
  });
  pi.on("agent_settled", (_event, ctx) => {
    context = ctx;
    running = false;
    schedule();
  });
  pi.on("input", (_event, ctx) => {
    context = ctx;
    schedule();
  });
  pi.on("ui_prompt_start", () => { dialogDepth++; });
  pi.on("ui_prompt_end", () => {
    dialogDepth = Math.max(0, dialogDepth - 1);
    if (dialogDepth === 0) schedule();
  });

  pi.registerCommand("ping", {
    description: "Enable/disable periodic idle wake-ups (default 5m), set interval, or show status",
    handler: async (args, ctx) => {
      context = ctx;
      const [action = "status", duration, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      if (extra.length || !["enable", "disable", "interval", "status"].includes(action) ||
        ((action === "disable" || action === "status") && duration) ||
        (action === "interval" && !duration)) {
        ctx.ui.notify(USAGE, "warning");
        return;
      }
      let interval = settings.intervalMs;
      if (duration) {
        const parsed = parseInterval(duration);
        if (parsed === undefined) {
          ctx.ui.notify("Interval must be 1s–24h (e.g. 5m, 30s, 1h; bare numbers are minutes).", "warning");
          return;
        }
        interval = parsed;
      }
      if (action === "status") {
        const next = nextPingAt === undefined ? "" : `; next check in ${Math.max(0, Math.ceil((nextPingAt - Date.now()) / 1000))}s`;
        ctx.ui.notify(`pi-ping ${settings.enabled ? "enabled" : "disabled"}; interval ${formatInterval(interval)}${next}`, "info");
        return;
      }
      settings = { enabled: action === "interval" ? settings.enabled : action === "enable", intervalMs: interval };
      pi.appendEntry(STATE_TYPE, { ...settings });
      updateStatus();
      schedule();
      ctx.ui.notify(`pi-ping ${settings.enabled ? "enabled" : "disabled"}; interval ${formatInterval(interval)}.` +
        (action === "enable" ? " Automatically starts model turns while idle, including after completion/Esc; use /ping disable to stop." : ""), "info");
    },
  });
}
