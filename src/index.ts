import { buildBot } from "./bot.js";
import { setDefaultCommands } from "./toolkit/index.js";
import { sendPendingReminders } from "./handlers/reminder.js";
import { sendDailySummaryToOwners } from "./handlers/admin.js";
import { getStore } from "./store.js";
import { now, todayString } from "./clock.js";

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error("BOT_TOKEN is required");
    process.exit(1);
  }
  const bot = await buildBot(token);
  // Publish the "/" command list to Telegram (discoverability). A button-first
  // bot exposes only /start + /help; everything else is reached via menu buttons.
  await setDefaultCommands(bot);

  // Automated reminder sweep — checks every 60 seconds for upcoming bookings
  // that need a reminder DM sent. Tolerates 403 from users who blocked the bot.
  const REMINDER_INTERVAL_MS = 60_000;
  const reminderTimer = setInterval(async () => {
    try {
      await sendPendingReminders(bot.api);
    } catch (err) {
      console.error("[reminder] sweep error:", err);
    }
  }, REMINDER_INTERVAL_MS);
  // Allow the Node process to exit even if the timer is still active on SIGINT
  reminderTimer.unref();

  // Daily capacity summary sweep — checks every 10 minutes and sends today's
  // summary to owners who have opted in, at most once per day.
  let lastSummaryDay = "";
  const SUMMARY_INTERVAL_MS = 600_000; // 10 minutes
  const summaryTimer = setInterval(async () => {
    try {
      const today = todayString();
      if (lastSummaryDay === today) return; // Already sent today
      const sent = await sendDailySummaryToOwners(bot.api);
      if (sent > 0) {
        lastSummaryDay = today;
        console.log(`[summary] daily summary sent to ${sent} owner(s)`);
      }
    } catch (err) {
      console.error("[summary] sweep error:", err);
    }
  }, SUMMARY_INTERVAL_MS);
  summaryTimer.unref();

  // Retention cleanup sweep — checks once per hour and removes expired bookings
  // that exceed the configured retention period.
  const CLEANUP_INTERVAL_MS = 3_600_000; // 1 hour
  const cleanupTimer = setInterval(async () => {
    try {
      const store = await getStore();
      const settings = await store.getDefaultSettings();
      const removed = await store.removeExpiredBookings(todayString(), settings.retention_days);
      if (removed > 0) {
        console.log(`[cleanup] removed ${removed} expired booking(s)`);
      }
    } catch (err) {
      console.error("[cleanup] sweep error:", err);
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  bot.start();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});