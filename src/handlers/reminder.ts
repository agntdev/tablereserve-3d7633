import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { getStore } from "../store.js";
import { now } from "../clock.js";

// Automated reminder handler — checks for bookings that need reminders and
// sends them. In production this is triggered by a cron job or setInterval;
// the handler also exposes a /remind command for manual testing.
//
// Reminders are DMs to guests. If a guest has blocked the bot or never
// started it, the 403 is silently handled per AGENTS.md "no abort on DM
// failure to a stranger."

const composer = new Composer<Ctx>();

// ---------------------------------------------------------------------------
// /remind — manually trigger reminder check (owner / dev use)
// ---------------------------------------------------------------------------

composer.command("remind", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  const store = await getStore();
  if (!(await store.isOwner(userId))) {
    await ctx.reply("Sorry, only the owner can run this.");
    return;
  }
  const sent = await sendPendingReminders(ctx.api);
  await ctx.reply(`✅ Checked for reminders. Sent ${sent} reminder(s).`);
});

// ---------------------------------------------------------------------------
// sendPendingReminders — scan upcoming bookings and send DMs
// ---------------------------------------------------------------------------

export async function sendPendingReminders(
  api: { sendMessage: (chatId: number, text: string, opts?: Record<string, unknown>) => Promise<unknown> },
): Promise<number> {
  const store = await getStore();
  const settings = await store.getDefaultSettings();
  const allUpcoming = await store.listAllUpcomingBookings();
  const reminderLeadMs = settings.reminder_lead_time * 60 * 1000;
  const current = now().getTime();
  let sent = 0;

  const pending = allUpcoming.filter((b) => {
    if (b.status !== "confirmed") return false;
    if (!b.chat_id) return false;
    if (b.reminded_at) return false; // Already sent a reminder
    const bookingTime = new Date(b.datetime).getTime();
    const remindAt = bookingTime - reminderLeadMs;
    // Reminder is due if remindAt is in the past but booking is still in the future
    return remindAt <= current && bookingTime > current;
  });

  for (const b of pending) {
    try {
      const ok = await sendReminderToBooking({ api }, b, store);
      if (ok) sent++;
    } catch {
      // 403 from blocked user or unexpected error — skip silently per AGENTS.md
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// sendReminderToBooking — send a reminder DM for one booking
// ---------------------------------------------------------------------------

export async function sendReminderToBooking(
  bot: { api: { sendMessage: (chatId: number, text: string, opts?: Record<string, unknown>) => Promise<unknown> } },
  booking: { code: string; datetime: string; guest_name: string; party_size: number; chat_id?: number },
  store?: { getBooking: (code: string) => Promise<any>; saveBooking: (b: any) => Promise<void> },
): Promise<boolean> {
  if (!booking.chat_id) return false;
  const dt = new Date(booking.datetime);
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  const dateStr = `${dt.getDate()}/${dt.getMonth() + 1}/${dt.getFullYear()}`;

  try {
    await bot.api.sendMessage(
      booking.chat_id,
      `⏰ Reminder! You have a booking today:\n\n` +
      `📋 Code: ${booking.code}\n` +
      `📅 ${dateStr} at ${hh}:${mm}\n` +
      `👥 ${booking.party_size} guests\n\n` +
      `See you soon! 🍽️`,
    );
    // Mark reminder as sent to prevent duplicate sends
    if (store) {
      const existing = await store.getBooking(booking.code);
      if (existing) {
        await store.saveBooking({ ...existing, reminded_at: now().toISOString() });
      }
    }
    return true;
  } catch (err) {
    const e = err as { statusCode?: number };
    if (e.statusCode === 403) {
      // User blocked bot or hasn't started it — skip silently
      return false;
    }
    // Re-throw unexpected errors
    throw err;
  }
}

export default composer;