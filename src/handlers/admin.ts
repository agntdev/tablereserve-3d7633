// Admin handler — owner dashboard with capacity summary, booking management,
// and no-show marking. Accessible via the /admin command.

import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  confirmKeyboard,
  paginate,
} from "../toolkit/index.js";
import { getStore, type Booking, type OwnerAccount } from "../storage.js";
import { todayString } from "../time.js";

const composer = new Composer<Ctx>();

// ─── Admin auth middleware ───────────────────────────────────────────────

async function requireOwner(ctx: Ctx, next: () => Promise<void>): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("Couldn't identify you. Try again?");
    return;
  }

  const store = getStore();
  const isOwner = await store.isOwner(userId);

  if (!isOwner) {
    await ctx.reply(
      "Sorry, this section is for restaurant staff only.\n\n" +
        "If you're a guest, tap /start to open the menu.",
    );
    return;
  }

  return next();
}

// ─── /admin command ──────────────────────────────────────────────────────

composer.command("admin", requireOwner, async (ctx) => {
  ctx.session.step = "admin:menu";
  await showAdminDashboard(ctx);
});

// Main owner dashboard — shows daily capacity + actions
async function showAdminDashboard(ctx: Ctx): Promise<void> {
  const store = getStore();
  const today = todayString();

  const settings = await store.getSettings();
  const dayOfWeek = new Date(today + "T12:00:00").getDay().toString();
  const isOpen = !!settings.openingHours[dayOfWeek];

  const bookings = await store.getActiveBookingsForDate(today);
  const tables = await store.getTables();
  const totalCapacity = tables.reduce((sum, t) => sum + t.capacity, 0);
  const bookedGuests = bookings.reduce((sum, b) => sum + b.partySize, 0);
  const utilization = totalCapacity > 0 ? Math.round((bookedGuests / totalCapacity) * 100) : 0;
  const cancelled = (await store.getBookingsForDate(today)).filter((b) => b.status === "cancelled");
  const noShows = (await store.getBookingsForDate(today)).filter((b) => b.status === "no_show");

  const statusIcon = isOpen ? "🟢" : "🔴";
  const text =
    "👋 Admin dashboard\n\n" +
    `${statusIcon} Today: ${today}\n` +
    `📊 Capacity: ${bookedGuests}/${totalCapacity} guests (${utilization}% full)\n` +
    `📅 Bookings today: ${bookings.length}\n` +
    `❌ Cancelled: ${cancelled.length}\n` +
    `🚫 No-shows: ${noShows.length}\n\n` +
    "What would you like to do?";

  const kb = inlineKeyboard([
    [inlineButton("📋 View today's bookings", "admin:today")],
    [inlineButton("📅 View all upcoming", "admin:upcoming")],
    [inlineButton("⚙️ Settings", "admin:settings")],
    [inlineButton("⬅️ Back to menu", "menu:main")],
  ]);

  await ctx.editMessageText(text, { reply_markup: kb });
}

composer.callbackQuery("admin:dashboard", requireOwner, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showAdminDashboard(ctx);
});

// ─── View today's bookings ───────────────────────────────────────────────

composer.callbackQuery("admin:today", requireOwner, async (ctx) => {
  await ctx.answerCallbackQuery();
  const store = getStore();
  const today = todayString();
  const bookings = await store.getBookingsForDate(today);
  const active = bookings.filter((b) => b.status === "confirmed");

  if (active.length === 0) {
    await ctx.editMessageText(
      "No bookings for today. Enjoy a quiet day!",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("⬅️ Back to dashboard", "admin:dashboard")],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  // Sort by time
  active.sort((a, b) => a.time.localeCompare(b.time));

  const lines = active.map(
    (b, i) =>
      `${i + 1}. 🕐 ${b.time} — ${b.guestName} (${b.partySize} guests) — ${b.code}`,
  );

  const buttons = active.map((b) => [
    inlineButton(`${b.time} ${b.guestName}`, `admin:booking:${b.code}`),
  ]);
  buttons.push([inlineButton("⬅️ Back to dashboard", "admin:dashboard")]);

  await ctx.editMessageText(
    "📋 Today's confirmed bookings:\n\n" + lines.join("\n") + "\n\nTap a booking to manage it.",
    { reply_markup: inlineKeyboard(buttons) },
  );
});

// ─── View all upcoming bookings (paginated) ──────────────────────────────

composer.callbackQuery("admin:upcoming", requireOwner, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showUpcomingPage(ctx, 0);
});

async function showUpcomingPage(ctx: Ctx, page: number): Promise<void> {
  const store = getStore();
  const bookings = await store.getUpcomingBookings();
  const active = bookings.filter((b) => b.status === "confirmed");
  active.sort((a, b) => a.datetime.localeCompare(b.datetime));

  if (active.length === 0) {
    await ctx.editMessageText(
      "No upcoming bookings.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("⬅️ Back to dashboard", "admin:dashboard")],
        ]),
      },
    );
    return;
  }

  const { pageItems, controls } = paginate(active, {
    page,
    perPage: 5,
    callbackPrefix: "admin:upcoming",
  });

  const lines = pageItems.map(
    (b) =>
      `📅 ${b.date} at ${b.time}\n` +
      `   ${b.guestName} (${b.partySize} guests) — ${b.code}\n`,
  );

  const rows: ReturnType<typeof inlineButton>[][] = pageItems.map((b) => [
    inlineButton(`${b.date} ${b.time} — ${b.guestName}`, `admin:booking:${b.code}`),
  ]);
  for (const ctrl of controls.inline_keyboard) {
    rows.push(ctrl);
  }
  rows.push([inlineButton("⬅️ Back to dashboard", "admin:dashboard")]);

  await ctx.editMessageText(
    "📅 Upcoming bookings (page " + (page + 1) + "/" + Math.ceil(active.length / 5) + "):\n\n" +
      lines.join("\n"),
    { reply_markup: inlineKeyboard(rows) },
  );
}

composer.callbackQuery(/^admin:upcoming:(prev|next):(\d+)$/, requireOwner, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match[2], 10);
  await showUpcomingPage(ctx, page);
});

// ─── View/edit single booking ────────────────────────────────────────────

composer.callbackQuery(/^admin:booking:(.+)$/, requireOwner, async (ctx) => {
  await ctx.answerCallbackQuery();
  const code = ctx.match[1];
  const store = getStore();
  const booking = await store.getBooking(code);

  if (!booking) {
    await ctx.editMessageText("Booking not found.", {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to dashboard", "admin:dashboard")]]),
    });
    return;
  }

  const statusEmoji: Record<string, string> = {
    confirmed: "✅",
    cancelled: "❌",
    no_show: "🚫",
    completed: "✔️",
  };

  const text =
    `Booking: ${code}\n\n` +
    `📅 ${booking.date} at ${booking.time}\n` +
    `👥 ${booking.partySize} guest${booking.partySize !== 1 ? "s" : ""}\n` +
    `👤 ${booking.guestName}\n` +
    `📱 ${booking.phone || "(not provided)"}\n` +
    `Status: ${statusEmoji[booking.status] ?? "❓"} ${booking.status}\n` +
    `🪑 Tables: ${booking.tablesUsed.join(", ")}\n` +
    `📅 Booked: ${booking.createdAt}`;

  const rows: ReturnType<typeof inlineButton>[][] = [];

  if (booking.status === "confirmed") {
    rows.push([inlineButton("🚫 Mark no-show", `admin:noshow:${code}`)]);
    rows.push([inlineButton("✅ Mark completed", `admin:complete:${code}`)]);
    rows.push([inlineButton("❌ Cancel booking", `cancel:booking:${code}`)]);
  } else if (booking.status === "no_show") {
    rows.push([inlineButton("↩️ Revert to confirmed", `admin:revert:${code}`)]);
  } else if (booking.status === "cancelled") {
    rows.push([inlineButton("↩️ Reactivate", `admin:reactivate:${code}`)]);
  }

  rows.push([inlineButton("⬅️ Back to dashboard", "admin:dashboard")]);

  await ctx.editMessageText(text, { reply_markup: inlineKeyboard(rows) });
});

// ─── Mark no-show ────────────────────────────────────────────────────────

composer.callbackQuery(/^admin:noshow:(.+)$/, requireOwner, async (ctx) => {
  await ctx.answerCallbackQuery();
  const code = ctx.match[1];

  await ctx.editMessageText(
    `Mark ${code} as no-show? The guest won't be charged, but the table will be freed.`,
    {
      reply_markup: confirmKeyboard(`admin:noshow:confirm:${code}`, {
        yes: "🚫 Yes, mark no-show",
        no: "🔙 Keep as confirmed",
      }),
    },
  );
});

composer.callbackQuery(/^admin:noshow:confirm:(.+):(yes|no)$/, requireOwner, async (ctx) => {
  await ctx.answerCallbackQuery();
  const code = ctx.match[1];
  const action = ctx.match[2];
  const store = getStore();
  const booking = await store.getBooking(code);

  if (!booking) {
    await ctx.editMessageText("Booking not found.", {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to dashboard", "admin:dashboard")]]),
    });
    return;
  }

  if (action === "no") {
    await showAdminBookingView(ctx, booking);
    return;
  }

  booking.status = "no_show";
  await store.updateBooking(booking);

  await ctx.editMessageText(
    `${code} marked as no-show. The table has been freed.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to dashboard", "admin:dashboard")],
      ]),
    },
  );
});

// ─── Mark completed ──────────────────────────────────────────────────────

composer.callbackQuery(/^admin:complete:(.+)$/, requireOwner, async (ctx) => {
  await ctx.answerCallbackQuery();
  const code = ctx.match[1];
  const store = getStore();
  const booking = await store.getBooking(code);

  if (!booking) {
    await ctx.editMessageText("Booking not found.", {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to dashboard", "admin:dashboard")]]),
    });
    return;
  }

  booking.status = "completed";
  await store.updateBooking(booking);

  await ctx.editMessageText(
    `${code} marked as completed.\n\nThe table is now available.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to dashboard", "admin:dashboard")],
      ]),
    },
  );
});

// ─── Revert no-show to confirmed ─────────────────────────────────────────

composer.callbackQuery(/^admin:revert:(.+)$/, requireOwner, async (ctx) => {
  await ctx.answerCallbackQuery();
  const code = ctx.match[1];
  const store = getStore();
  const booking = await store.getBooking(code);

  if (!booking) {
    await ctx.editMessageText("Booking not found.", { reply_markup: inlineKeyboard([]) });
    return;
  }

  booking.status = "confirmed";
  await store.updateBooking(booking);

  await ctx.editMessageText(`${code} reverted to confirmed.`, {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to dashboard", "admin:dashboard")]]),
  });
});

// ─── Reactivate cancelled booking ────────────────────────────────────────

composer.callbackQuery(/^admin:reactivate:(.+)$/, requireOwner, async (ctx) => {
  await ctx.answerCallbackQuery();
  const code = ctx.match[1];
  const store = getStore();
  const booking = await store.getBooking(code);

  if (!booking) {
    await ctx.editMessageText("Booking not found.", { reply_markup: inlineKeyboard([]) });
    return;
  }

  booking.status = "confirmed";
  await store.updateBooking(booking);

  await ctx.editMessageText(`${code} reactivated.`, {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to dashboard", "admin:dashboard")]]),
  });
});

// ─── Settings ────────────────────────────────────────────────────────────

composer.callbackQuery("admin:settings", requireOwner, async (ctx) => {
  await ctx.answerCallbackQuery();
  const store = getStore();
  const s = await store.getSettings();

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const hoursLines = Object.entries(s.openingHours)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([d, h]) => {
      const name = dayNames[Number(d)] ?? d;
      return `${name}: ${h || "Closed"}`;
    });

  const text =
    "⚙️ Restaurant settings\n\n" +
    hoursLines.join("\n") +
    "\n\n" +
    `Seat duration: ${s.seatDurationMinutes} min\n` +
    `Booking window: ${s.advanceWindowDays} days ahead\n` +
    `Reminder lead: ${s.reminderLeadMinutes} min before\n` +
    `Party size: ${s.minPartySize}–${s.maxPartySize} guests\n\n` +
    "These are the defaults. Edit them through your restaurant management system.";

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to dashboard", "admin:dashboard")]]),
  });
});

// ─── Helper: show admin booking view ─────────────────────────────────────

async function showAdminBookingView(ctx: Ctx, booking: Booking): Promise<void> {
  const statusEmoji: Record<string, string> = {
    confirmed: "✅",
    cancelled: "❌",
    no_show: "🚫",
    completed: "✔️",
  };

  const text =
    `Booking: ${booking.code}\n\n` +
    `📅 ${booking.date} at ${booking.time}\n` +
    `👥 ${booking.partySize} guest${booking.partySize !== 1 ? "s" : ""}\n` +
    `👤 ${booking.guestName}\n` +
    `📱 ${booking.phone || "(not provided)"}\n` +
    `Status: ${statusEmoji[booking.status] ?? "❓"} ${booking.status}\n` +
    `🪑 Tables: ${booking.tablesUsed.join(", ")}`;

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to dashboard", "admin:dashboard")]]),
  });
}

export default composer;