// Reminder handler — automated guest reminders and owner notifications.
// In a real deployment, these would run on a cron/scheduler. The handlers here
// provide the send logic that a scheduler would call.

import { Composer, type Api, type RawApi } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton } from "../toolkit/index.js";
import { getStore, type Booking } from "../storage.js";
import { now, todayString } from "../time.js";

const composer = new Composer<Ctx>();

// ─── Owner alert on new booking ──────────────────────────────────────────
// This is triggered from the booking flow after confirmation

import type { Api, RawApi } from "grammy";

export async function notifyOwnerNewBooking(
  botApi: Api<RawApi>,
  booking: Booking,
): Promise<void> {
  const store = getStore();
  const owners = await store.getOwnerAccounts();

  const text =
    "🆕 New booking!\n\n" +
    `Code: ${booking.code}\n` +
    `📅 ${booking.date} at ${booking.time}\n` +
    `👥 ${booking.partySize} guests\n` +
    `👤 ${booking.guestName}\n` +
    `📱 ${booking.phone || "(not provided)"}\n` +
    `🪑 Table: ${booking.tablesUsed.join(", ")}`;

  for (const owner of owners) {
    try {
      await botApi.sendMessage(owner.telegramId, text, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "👀 View booking", callback_data: `admin:booking:${booking.code}` }],
          ],
        },
      });
    } catch {
      // Owner may have blocked the bot — skip silently
    }
  }
}

// ─── Guest reminder ──────────────────────────────────────────────────────

export async function sendGuestReminder(
  botApi: Api<RawApi>,
  booking: Booking,
): Promise<boolean> {
  const hoursUntil = getHoursUntil(booking.date, booking.time);
  const timeLabel =
    hoursUntil <= 0
      ? "now"
      : hoursUntil < 2
        ? "in about an hour"
        : `in about ${Math.round(hoursUntil)} hours`;

  const text =
    `🔔 Reminder: Your booking at ${booking.time} is ${timeLabel}!\n\n` +
    `📅 ${booking.date} at ${booking.time}\n` +
    `👥 ${booking.partySize} guest${booking.partySize !== 1 ? "s" : ""}\n` +
    `Code: ${booking.code}\n\n` +
    "Need to make changes?";

  try {
    await botApi.sendMessage(booking.guestChatId, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Reschedule", callback_data: `reschedule:${booking.code}` }],
          [{ text: "❌ Cancel", callback_data: `cancel:booking:${booking.code}` }],
        ],
      },
    });
    return true;
  } catch {
    // Guest may have blocked the bot — skip silently
    return false;
  }
}

// ─── Daily capacity summary ──────────────────────────────────────────────

export async function sendDailySummary(
  botApi: Api<RawApi>,
): Promise<void> {
  const store = getStore();
  const today = todayString();
  const owners = await store.getOwnerAccounts();

  if (owners.length === 0) return;

  const settings = await store.getSettings();
  const dayOfWeek = new Date(today + "T12:00:00").getDay().toString();
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const isOpen = !!settings.openingHours[dayOfWeek];
  const bookings = await store.getActiveBookingsForDate(today);
  const tables = await store.getTables();
  const totalCapacity = tables.reduce((sum, t) => sum + t.capacity, 0);
  const bookedGuests = bookings.reduce((sum, b) => sum + b.partySize, 0);
  const utilization = totalCapacity > 0 ? Math.round((bookedGuests / totalCapacity) * 100) : 0;

  const todayAll = await store.getBookingsForDate(today);
  const cancelled = todayAll.filter((b) => b.status === "cancelled").length;
  const noShows = todayAll.filter((b) => b.status === "no_show").length;

  const dayName = dayNames[Number(dayOfWeek)];
  const openStatus = isOpen ? "Open" : "Closed";
  const openHours = isOpen ? ` (${settings.openingHours[dayOfWeek]})` : "";

  const text =
    `📊 Daily summary — ${dayName}, ${today}\n\n` +
    `${isOpen ? "🟢" : "🔴"} Status: ${openStatus}${openHours}\n` +
    `📊 Capacity: ${bookedGuests}/${totalCapacity} guests (${utilization}% full)\n` +
    `📅 Bookings: ${bookings.length}\n` +
    `❌ Cancelled: ${cancelled}\n` +
    `🚫 No-shows: ${noShows}\n\n` +
    "Get ready for a great service day!";

  for (const owner of owners) {
    try {
      await botApi.sendMessage(owner.telegramId, text, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "👀 View today's bookings", callback_data: "admin:today" }],
            [{ text: "⬅️ Back to menu", callback_data: "menu:main" }],
          ],
        },
      });
    } catch {
      // Owner may have blocked the bot — skip silently
    }
  }
}

// ─── Check due reminders (call periodically) ─────────────────────────────

export async function checkDueReminders(
  botApi: Api<RawApi>,
): Promise<number> {
  const store = getStore();
  const settings = await store.getSettings();
  const leadMs = settings.reminderLeadMinutes * 60 * 1000;
  const nowDate = now();

  const upcoming = await store.getUpcomingBookings();
  const confirmed = upcoming.filter((b) => b.status === "confirmed");

  let sent = 0;
  for (const booking of confirmed) {
    const bookingTime = new Date(booking.datetime).getTime();
    const diffMs = bookingTime - nowDate.getTime();

    // Send reminder if within lead time but not yet past
    if (diffMs > 0 && diffMs <= leadMs) {
      // Check if reminder was already sent — we store this in the booking metadata
      // For simplicity, we use a separate index: reminders:sent:{code}
      const reminderKey = `reminder:sent:${booking.code}`;
      const alreadySent = await store.store.read(reminderKey);
      if (!alreadySent) {
        const ok = await sendGuestReminder(botApi, booking);
        if (ok) {
          await store.store.write(reminderKey, "1");
          sent++;
        }
      }
    }
  }

  return sent;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function getHoursUntil(date: string, time: string): number {
  const bookingDate = new Date(`${date}T${time}:00`);
  const diffMs = bookingDate.getTime() - now().getTime();
  return diffMs / (1000 * 60 * 60);
}

export default composer;