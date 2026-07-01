import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";

// /help — plain-language explanation for non-technical users. This bot is
// button-driven: tell the user to tap /start to open the menu rather than listing
// slash commands. The same text is shown when the user taps the Help button on the
// main menu (`menu:help`). Enhance the copy for your specific bot; keep it short.
const composer = new Composer<Ctx>();

const HELP =
  "Welcome to TableReserve! Here's how it works:\n\n" +
  "📅 Tap /start to open the menu, then:\n" +
  "• Book a table — pick date, time, and party size\n" +
  "• View your upcoming bookings\n" +
  "• Reschedule or cancel anytime\n\n" +
  "🔔 We'll send you a reminder before your reservation.\n\n" +
  "If you're restaurant staff, use /admin to manage bookings.";

const backToMenu = inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]);

composer.command("help", async (ctx) => {
  await ctx.reply(HELP);
});

composer.callbackQuery("menu:help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(HELP, { reply_markup: backToMenu });
});

export default composer;
