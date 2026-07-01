import { buildBot } from "./bot.js";
import { setDefaultCommands } from "./toolkit/index.js";
import { sendPendingReminders } from "./handlers/reminder.js";

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

  bot.start();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
