import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";

const composer = new Composer<Ctx>();

// /cancel — stop any active flow and return to the menu.
composer.command("cancel", async (ctx) => {
  ctx.session.step = "idle";
  await ctx.reply("Cancelled. Tap /start to open the menu.", {
    reply_markup: inlineKeyboard([
      [inlineButton("⬅️ Back to menu", "menu:main")],
    ]),
  });
});

export default composer;
