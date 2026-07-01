import { Composer } from "grammy";
import { readdirSync } from "node:fs";
import { createBot, type BotContext } from "./toolkit/index.js";
import { now } from "./clock.js";

// Per-chat ephemeral conversation state. Durable domain data (bookings,
// settings, tables, owner accounts) lives in PersistentStore (src/store.ts).
export interface Session {
  step?: string;
  // Flow timeout — unix ms after which the flow auto-expires
  expiresAt?: number;
  // Booking flow data
  bookingDate?: string;
  bookingTime?: string;
  bookingPartySize?: number;
  bookingGuestName?: string;
  bookingPhone?: string;
  // Reschedule flow data
  rescheduleCode?: string;
  // Admin flow data
  adminTableName?: string;
  adminEditCode?: string;
}

export type Ctx = BotContext<Session>;

// Flow timeout duration (10 minutes).
const FLOW_TTL_MS = 10 * 60 * 1000;

/** Set the session step and a flow timeout. */
export function enterStep(ctx: Ctx, step: string): void {
  ctx.session.step = step;
  ctx.session.expiresAt = now().getTime() + FLOW_TTL_MS;
}

/** Text shown when a flow times out. */
export const FLOW_TIMEOUT_TEXT = "The flow timed out. Tap /start to begin again.";

/**
 * buildBot — assembles the bot, AUTO-LOADS every feature handler from
 * src/handlers/, then registers the global fallback. Does NOT start the bot.
 * Add a feature by creating src/handlers/<name>.ts that default-exports a grammY
 * Composer — NEVER edit this file (concurrent feature PRs would conflict).
 */
export async function buildBot(token: string) {
  const bot = createBot<Session>(token, {
    initial: () => ({}),
  });

  // Flow timeout sweeper — resets expired flows before any handler runs.
  bot.use(async (ctx, next) => {
    if (ctx.session.expiresAt && now().getTime() > ctx.session.expiresAt && ctx.session.step && ctx.session.step !== "idle") {
      ctx.session.step = "idle";
      ctx.session.expiresAt = undefined;
      await ctx.reply(FLOW_TIMEOUT_TEXT);
      return;
    }
    return next();
  });

  const dir = new URL("./handlers/", import.meta.url);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter(
      (f) =>
        (f.endsWith(".js") || f.endsWith(".ts")) &&
        !f.endsWith(".d.ts") &&
        !f.includes(".test.") &&
        !f.includes(".spec."),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    files = [];
  }
  for (const file of files.sort()) {
    const mod = (await import(new URL(file, dir).href)) as { default?: Composer<Ctx> };
    if (!mod.default) {
      throw new Error(`handler ${file} must default-export a grammY Composer`);
    }
    bot.use(mod.default);
  }

  bot.on("message", (ctx) => ctx.reply("Sorry, I didn't understand that. Try /help."));

  return bot;
}