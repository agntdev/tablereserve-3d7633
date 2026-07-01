import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { enterStep } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
  paginate,
  type InlineButton,
} from "../toolkit/index.js";
import { getStore, type Booking, type OwnerNotificationPrefs } from "../store.js";
import { todayString, dateString, daysFromNow, now } from "../clock.js";

// Admin is a slash command per spec, plus a main-menu button for owners who
// are already registered.
registerMainMenuItem({
  label: "⚙️ Admin",
  data: "admin:dashboard",
  order: 90,
});

const composer = new Composer<Ctx>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatDateNice(d: Date): string {
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

function formatDateTime(dt: string): string {
  const d = new Date(dt);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${formatDateNice(d)} at ${hh}:${mm}`;
}

async function ensureOwner(ctx: Ctx): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("Couldn't identify you.");
    return false;
  }
  const store = await getStore();
  if (!(await store.isOwner(userId))) {
    await ctx.reply(
      "Sorry, you don't have admin access. Contact the restaurant owner to be added.",
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// /admin command
// ---------------------------------------------------------------------------

composer.command("admin", async (ctx) => {
  if (!(await ensureOwner(ctx))) return;
  await showDashboard(ctx);
});

composer.callbackQuery("admin:dashboard", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await ensureOwner(ctx))) return;
  await ctx.editMessageText("Loading dashboard…");
  await showDashboard(ctx);
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

async function showDashboard(ctx: Ctx): Promise<void> {
  const store = await getStore();
  const today = todayString();
  const settings = await store.getDefaultSettings();
  const todayBookings = await store.listBookingsByDate(today);
  const tables = await store.listTables();

  const confirmedToday = todayBookings.filter((b) => b.status === "confirmed");
  const totalCapacity = tables.reduce((sum, t) => sum + t.capacity, 0);

  const niceToday = formatDateNice(new Date(today + "T12:00:00"));

  const msg =
    `⚙️ Admin Dashboard — ${niceToday}\n\n` +
    `📊 Today's bookings: ${confirmedToday.length} confirmed\n` +
    `🪑 Tables: ${tables.length} (total capacity: ${totalCapacity})\n` +
    `⏱ Seat duration: ${settings.seat_duration} min\n\n` +
    `What would you like to do?`;

  await ctx.reply(msg, {
    reply_markup: inlineKeyboard([
      [inlineButton("📋 Today's bookings", "admin:list_today")],
      [inlineButton("🏠 Manage tables", "admin:tables")],
      [inlineButton("⚙️ Settings", "admin:settings")],
      [inlineButton("🔔 Notifications", "admin:notifications")],
      [inlineButton("📅 Daily summary", "admin:summary")],
      [inlineButton("⬅️ Back to menu", "menu:main")],
    ]),
  });
}

// ---------------------------------------------------------------------------
// List today's bookings
// ---------------------------------------------------------------------------

composer.callbackQuery("admin:list_today", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await ensureOwner(ctx))) return;

  const store = await getStore();
  const today = todayString();
  const bookings = await store.listBookingsByDate(today);
  const active = bookings.filter(
    (b) => b.status === "confirmed" || b.status === "completed",
  );

  if (active.length === 0) {
    await ctx.editMessageText(
      "📋 No bookings today. Enjoy a quiet shift!",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("⬅️ Back to dashboard", "admin:dashboard")],
        ]),
      },
    );
    return;
  }

  await renderBookingList(ctx, active, 0, "admin:list_today_page");
});

async function renderBookingList(
  ctx: Ctx,
  bookings: Booking[],
  page: number,
  prefix: string,
): Promise<void> {
  const { pageItems, controls, totalPages, page: actualPage } = paginate(bookings, {
    page,
    perPage: 5,
    callbackPrefix: prefix,
  });

  let msg = `📋 Bookings (page ${actualPage + 1}/${totalPages}):\n\n`;
  for (const b of pageItems) {
    const dt = formatDateTime(b.datetime);
    const statusIcon =
      b.status === "confirmed"
        ? "✅"
        : b.status === "completed"
          ? "✔️"
          : b.status === "no_show"
            ? "❌"
            : "🚫";
    msg += `${statusIcon} ${b.code} — ${dt}\n`;
    msg += `   ${b.guest_name}, ${b.party_size} guests\n`;
  }

  const actionRows: InlineButton[][] = pageItems.map((b) => [
    inlineButton(`${b.code} — ${b.guest_name}`, `admin:booking:${b.code}`),
  ]);

  const keyboard = inlineKeyboard([
    ...actionRows,
    ...controls.inline_keyboard,
    [inlineButton("⬅️ Back to dashboard", "admin:dashboard")],
  ]);

  await ctx.editMessageText(msg, { reply_markup: keyboard });
}

// Pagination handlers for today's list
composer.callbackQuery(/^admin:list_today_page:prev:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await ensureOwner(ctx))) return;
  const page = parseInt(ctx.callbackQuery.data.split(":").pop()!, 10);
  const store = await getStore();
  const bookings = (await store.listBookingsByDate(todayString())).filter(
    (b) => b.status === "confirmed" || b.status === "completed",
  );
  await renderBookingList(ctx, bookings, page, "admin:list_today_page");
});

composer.callbackQuery(/^admin:list_today_page:next:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await ensureOwner(ctx))) return;
  const page = parseInt(ctx.callbackQuery.data.split(":").pop()!, 10);
  const store = await getStore();
  const bookings = (await store.listBookingsByDate(todayString())).filter(
    (b) => b.status === "confirmed" || b.status === "completed",
  );
  await renderBookingList(ctx, bookings, page, "admin:list_today_page");
});

// ---------------------------------------------------------------------------
// Single booking detail
// ---------------------------------------------------------------------------

composer.callbackQuery(/^admin:booking:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await ensureOwner(ctx))) return;
  const code = ctx.callbackQuery.data.replace("admin:booking:", "");
  const store = await getStore();
  const booking = await store.getBooking(code);
  if (!booking) {
    await ctx.editMessageText("Couldn't find that booking.");
    return;
  }

  const dt = formatDateTime(booking.datetime);
  const statusLabel =
    booking.status === "confirmed"
      ? "✅ Confirmed"
      : booking.status === "cancelled"
        ? "🚫 Cancelled"
        : booking.status === "no_show"
          ? "❌ No show"
          : "✔️ Completed";

  const msg =
    `📋 Booking ${booking.code}\n\n` +
    `Status: ${statusLabel}\n` +
    `📅 ${dt}\n` +
    `👤 ${booking.guest_name}\n` +
    `📞 ${booking.phone || "—"}\n` +
    `👥 ${booking.party_size} guests\n` +
    `🆔 Code: ${booking.code}`;

  const buttons: InlineButton[] = [];
  if (booking.status === "confirmed") {
    buttons.push(
      inlineButton("✏️ Edit booking", `admin:edit:${booking.code}`),
      inlineButton("❌ Mark no-show", `admin:no_show:${booking.code}`),
      inlineButton("✔️ Mark completed", `admin:complete:${booking.code}`),
    );
  }

  await ctx.editMessageText(msg, {
    reply_markup: inlineKeyboard([
      buttons,
      [inlineButton("⬅️ Back to bookings list", "admin:list_today")],
      [inlineButton("⬅️ Back to dashboard", "admin:dashboard")],
    ]),
  });
});

// ---------------------------------------------------------------------------
// Mark no-show
// ---------------------------------------------------------------------------

composer.callbackQuery(/^admin:no_show:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await ensureOwner(ctx))) return;
  const code = ctx.callbackQuery.data.replace("admin:no_show:", "");
  const store = await getStore();
  const booking = await store.updateBookingStatus(code, "no_show");
  if (booking) {
    await ctx.editMessageText(
      `❌ Booking ${code} marked as no-show.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("⬅️ Back to dashboard", "admin:dashboard")],
        ]),
      },
    );
  }
});

composer.callbackQuery(/^admin:complete:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await ensureOwner(ctx))) return;
  const code = ctx.callbackQuery.data.replace("admin:complete:", "");
  const store = await getStore();
  const booking = await store.updateBookingStatus(code, "completed");
  if (booking) {
    await ctx.editMessageText(
      `✔️ Booking ${code} marked as completed.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("⬅️ Back to dashboard", "admin:dashboard")],
        ]),
      },
    );
  }
});

// ---------------------------------------------------------------------------
// Table management
// ---------------------------------------------------------------------------

composer.callbackQuery("admin:tables", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await ensureOwner(ctx))) return;

  const store = await getStore();
  const tables = await store.listTables();

  let msg = "🏠 Manage tables\n\n";
  if (tables.length === 0) {
    msg += "No tables set up yet. Add your first table below.";
  } else {
    msg += tables
      .map(
        (t, i) =>
          `${i + 1}. ${t.name} (${t.capacity} guests)`,
      )
      .join("\n");
  }

  await ctx.editMessageText(msg, {
    reply_markup: inlineKeyboard([
      [inlineButton("➕ Add table", "admin:add_table")],
      tables.length > 0
        ? [inlineButton("🗑 Remove table", "admin:remove_table")]
        : [],
      [inlineButton("⬅️ Back to dashboard", "admin:dashboard")],
    ]),
  });
});

// ---------------------------------------------------------------------------
// Add table flow
// ---------------------------------------------------------------------------

composer.callbackQuery("admin:add_table", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await ensureOwner(ctx))) return;
  enterStep(ctx, "admin:add_table_name");
  await ctx.editMessageText(
    "Enter a name for the new table (e.g. 'Table 1' or 'Window table'):",
    { reply_markup: inlineKeyboard([[
      inlineButton("⬅️ Cancel", "admin:tables"),
    ]]) },
  );
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "admin:add_table_name") return next();
  const name = ctx.message.text.trim();
  if (name.length < 1) {
    await ctx.reply("Name can't be empty.");
    return;
  }

  ctx.session.adminTableName = name;
  enterStep(ctx, "admin:add_table_capacity");
  await ctx.reply(
    `Got it — "${name}". How many guests can this table seat?`,
    { reply_markup: { force_reply: true, input_field_placeholder: "e.g. 4" } },
  );
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "admin:add_table_capacity") return next();
  const n = parseInt(ctx.message.text.trim(), 10);
  if (isNaN(n) || n < 1) {
    await ctx.reply("Please enter a number greater than 0.");
    return;
  }

  const tableName = ctx.session.adminTableName ?? `Table ${n}`;
  const store = await getStore();
  const tableId = `T${now().getTime()}`;
  await store.saveTable({ id: tableId, capacity: n, name: tableName });
  ctx.session.step = "idle";
  await ctx.reply(`✅ Table "${tableName}" (${n} guests) added!`, {
    reply_markup: inlineKeyboard([
      [inlineButton("🏠 Back to tables", "admin:tables")],
    ]),
  });
});

// ---------------------------------------------------------------------------
// Remove table flow
// ---------------------------------------------------------------------------

composer.callbackQuery("admin:remove_table", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await ensureOwner(ctx))) return;

  const store = await getStore();
  const tables = await store.listTables();
  if (tables.length === 0) {
    await ctx.editMessageText("No tables to remove.", {
      reply_markup: inlineKeyboard([[
        inlineButton("⬅️ Back", "admin:tables"),
      ]]),
    });
    return;
  }

  const rows = tables.map((t) => [
    inlineButton(`${t.name} (${t.capacity})`, `admin:remove_table:${t.id}`),
  ]);
  rows.push([inlineButton("⬅️ Cancel", "admin:tables")]);
  await ctx.editMessageText("Tap a table to remove:", {
    reply_markup: inlineKeyboard(rows),
  });
});

composer.callbackQuery(/^admin:remove_table:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await ensureOwner(ctx))) return;
  const id = ctx.callbackQuery.data.replace("admin:remove_table:", "");
  const store = await getStore();
  await store.deleteTable(id);
  await ctx.editMessageText("🗑 Table removed.", {
    reply_markup: inlineKeyboard([[
      inlineButton("🏠 Back to tables", "admin:tables"),
    ]]),
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

composer.callbackQuery("admin:settings", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await ensureOwner(ctx))) return;

  const store = await getStore();
  const settings = await store.getDefaultSettings();

  const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const hoursStr = days
    .map((d) => {
      const h = settings.opening_hours[d];
      const label = d.charAt(0).toUpperCase() + d.slice(1);
      return h ? `${label}: ${h.open}–${h.close}` : `${label}: Closed`;
    })
    .join("\n");

  const msg =
    "⚙️ Current settings:\n\n" +
    hoursStr + "\n" +
    `⏱ Seat duration: ${settings.seat_duration} min\n` +
    `📅 Advance booking window: ${settings.advance_window} days\n` +
    `⏰ Reminder lead time: ${settings.reminder_lead_time} min before`;

  await ctx.editMessageText(msg, {
    reply_markup: inlineKeyboard([
      [inlineButton("⏱ Set seat duration", "admin:set_duration")],
      [inlineButton("📅 Set booking window", "admin:set_window")],
      [inlineButton("⏰ Set reminder lead time", "admin:set_reminder_lead")],
      [inlineButton("⬅️ Back to dashboard", "admin:dashboard")],
    ]),
  });
});

// Seat duration
composer.callbackQuery("admin:set_duration", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await ensureOwner(ctx))) return;
  enterStep(ctx, "admin:duration");
  await ctx.editMessageText(
    "Enter seat duration in minutes (e.g. 90):",
    { reply_markup: inlineKeyboard([[
      inlineButton("⬅️ Cancel", "admin:settings"),
    ]]) },
  );
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "admin:duration") return next();
  const n = parseInt(ctx.message.text.trim(), 10);
  if (isNaN(n) || n < 15 || n > 240) {
    await ctx.reply("Please enter a number between 15 and 240 minutes.");
    return;
  }
  const store = await getStore();
  const settings = await store.getDefaultSettings();
  settings.seat_duration = n;
  await store.saveSettings(settings);
  ctx.session.step = "idle";
  await ctx.reply(`✅ Seat duration set to ${n} minutes.`, {
    reply_markup: inlineKeyboard([[
      inlineButton("⬅️ Back to settings", "admin:settings"),
    ]]),
  });
});

// Booking window
composer.callbackQuery("admin:set_window", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await ensureOwner(ctx))) return;
  enterStep(ctx, "admin:window");
  await ctx.editMessageText(
    "Enter the advance booking window in days (e.g. 30):",
    { reply_markup: inlineKeyboard([[
      inlineButton("⬅️ Cancel", "admin:settings"),
    ]]) },
  );
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "admin:window") return next();
  const n = parseInt(ctx.message.text.trim(), 10);
  if (isNaN(n) || n < 1 || n > 365) {
    await ctx.reply("Please enter a number between 1 and 365 days.");
    return;
  }
  const store = await getStore();
  const settings = await store.getDefaultSettings();
  settings.advance_window = n;
  await store.saveSettings(settings);
  ctx.session.step = "idle";
  await ctx.reply(`✅ Booking window set to ${n} days.`, {
    reply_markup: inlineKeyboard([[
      inlineButton("⬅️ Back to settings", "admin:settings"),
    ]]),
  });
});

// Reminder lead time
composer.callbackQuery("admin:set_reminder_lead", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await ensureOwner(ctx))) return;
  enterStep(ctx, "admin:reminder_lead");
  await ctx.editMessageText(
    "Enter reminder lead time in minutes before the booking (e.g. 60):",
    { reply_markup: inlineKeyboard([[
      inlineButton("⬅️ Cancel", "admin:settings"),
    ]]) },
  );
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "admin:reminder_lead") return next();
  const n = parseInt(ctx.message.text.trim(), 10);
  if (isNaN(n) || n < 5 || n > 1440) {
    await ctx.reply("Please enter a number between 5 and 1440 minutes.");
    return;
  }
  const store = await getStore();
  const settings = await store.getDefaultSettings();
  settings.reminder_lead_time = n;
  await store.saveSettings(settings);
  ctx.session.step = "idle";
  await ctx.reply(`✅ Reminder lead time set to ${n} minutes.`, {
    reply_markup: inlineKeyboard([[
      inlineButton("⬅️ Back to settings", "admin:settings"),
    ]]),
  });
});

// ---------------------------------------------------------------------------
// Notification preferences (per-owner toggle)
// ---------------------------------------------------------------------------

composer.callbackQuery("admin:notifications", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await ensureOwner(ctx))) return;

  const userId = ctx.from!.id;
  const store = await getStore();
  const settings = await store.getDefaultSettings();
  const prefs = await store.getOwnerPrefs(userId);

  const msg =
    "🔔 Notification Preferences\n\n" +
    `⏰ Reminder lead time: ${settings.reminder_lead_time} min before\n` +
    `   (Configure in ⚙️ Settings)\n\n` +
    "Per-owner preferences:";

  await ctx.editMessageText(msg, {
    reply_markup: inlineKeyboard([
      [
        inlineButton(
          `${prefs.new_booking_alerts ? "✅" : "☑️"} New booking alerts`,
          `admin:toggle:new_booking_alerts`,
        ),
      ],
      [
        inlineButton(
          `${prefs.daily_summary ? "✅" : "☑️"} Daily summary`,
          `admin:toggle:daily_summary`,
        ),
      ],
      [inlineButton("⬅️ Back to dashboard", "admin:dashboard")],
    ]),
  });
});

composer.callbackQuery(/^admin:toggle:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await ensureOwner(ctx))) return;

  const userId = ctx.from!.id;
  const key = ctx.callbackQuery.data.replace("admin:toggle:", "") as keyof OwnerNotificationPrefs;
  const store = await getStore();
  const prefs = await store.getOwnerPrefs(userId);
  prefs[key] = !prefs[key];
  await store.saveOwnerPrefs(userId, prefs);

  // Re-render notifications view
  const settings = await store.getDefaultSettings();
  const msg =
    "🔔 Notification Preferences\n\n" +
    `⏰ Reminder lead time: ${settings.reminder_lead_time} min before\n` +
    `   (Configure in ⚙️ Settings)\n\n` +
    "Per-owner preferences:";

  await ctx.editMessageText(msg, {
    reply_markup: inlineKeyboard([
      [
        inlineButton(
          `${prefs.new_booking_alerts ? "✅" : "☑️"} New booking alerts`,
          `admin:toggle:new_booking_alerts`,
        ),
      ],
      [
        inlineButton(
          `${prefs.daily_summary ? "✅" : "☑️"} Daily summary`,
          `admin:toggle:daily_summary`,
        ),
      ],
      [inlineButton("⬅️ Back to dashboard", "admin:dashboard")],
    ]),
  });
});

// ---------------------------------------------------------------------------
// Daily summary
// ---------------------------------------------------------------------------

composer.callbackQuery("admin:summary", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await ensureOwner(ctx))) return;

  const store = await getStore();
  const today = todayString();
  const tomorrow = dateString(daysFromNow(1));
  const bookingsToday = await store.listBookingsByDate(today);
  const bookingsTomorrow = await store.listBookingsByDate(tomorrow);

  const confirmedToday = bookingsToday.filter((b) => b.status === "confirmed");
  const confirmedTomorrow = bookingsTomorrow.filter(
    (b) => b.status === "confirmed",
  );

  const niceToday = formatDateNice(new Date(today + "T12:00:00"));
  const niceTomorrow = formatDateNice(new Date(tomorrow + "T12:00:00"));

  const parts: string[] = [`📅 Daily Summary\n`];
  parts.push(`📆 ${niceToday}: ${confirmedToday.length} booking(s)`);
  for (const b of confirmedToday) {
    const dt = new Date(b.datetime);
    const hh = String(dt.getHours()).padStart(2, "0");
    const mm = String(dt.getMinutes()).padStart(2, "0");
    parts.push(`   ${hh}:${mm} — ${b.guest_name} (${b.party_size})`);
  }
  parts.push(`\n📆 ${niceTomorrow}: ${confirmedTomorrow.length} booking(s)`);
  for (const b of confirmedTomorrow) {
    const dt = new Date(b.datetime);
    const hh = String(dt.getHours()).padStart(2, "0");
    const mm = String(dt.getMinutes()).padStart(2, "0");
    parts.push(`   ${hh}:${mm} — ${b.guest_name} (${b.party_size})`);
  }

  await ctx.editMessageText(parts.join("\n"), {
    reply_markup: inlineKeyboard([
      [inlineButton("⬅️ Back to dashboard", "admin:dashboard")],
    ]),
  });
});

export default composer;