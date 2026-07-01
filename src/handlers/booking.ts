import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { enterStep } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import { getStore, type Booking, type OwnerNotificationPrefs } from "../store.js";
import { todayString, dateString, daysFromNow, now } from "../clock.js";

registerMainMenuItem({
  label: "📅 Book a table",
  data: "booking:start",
  order: 10,
});

const composer = new Composer<Ctx>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatDateNice(d: Date): string {
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

export function parseDateInput(text: string): Date | null {
  const t = text.trim();
  // DD/MM or DD/MM/YYYY
  const parts = t.split(/[/\-.]/);
  if (parts.length < 2) return null;
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  if (isNaN(day) || isNaN(month)) return null;
  let year = parts.length >= 3 ? parseInt(parts[2], 10) : now().getFullYear();
  if (year < 100) year += 2000;
  const d = new Date(year, month - 1, day);
  if (d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

const MAX_PARTY_SIZE = 20;

// ---------------------------------------------------------------------------
// Main menu entry
// ---------------------------------------------------------------------------

composer.callbackQuery("booking:start", async (ctx) => {
  await ctx.answerCallbackQuery();
  enterStep(ctx, "booking:date");
  ctx.session.bookingDate = undefined;
  ctx.session.bookingTime = undefined;
  ctx.session.bookingPartySize = undefined;
  ctx.session.bookingGuestName = undefined;
  ctx.session.bookingPhone = undefined;
  await ctx.editMessageText(
    "📅 What date would you like to book? (DD/MM or DD/MM/YYYY)",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    },
  );
});

// ---------------------------------------------------------------------------
// Date input
// ---------------------------------------------------------------------------

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "booking:date") return next();

  const text = ctx.message.text.trim();
  const parsed = parseDateInput(text);
  if (!parsed) {
    await ctx.reply(
      "Couldn't recognise that date. Please use DD/MM format, e.g. 15/07.",
      { reply_markup: { force_reply: true, input_field_placeholder: "DD/MM" } },
    );
    return;
  }

  const today = new Date(todayString() + "T12:00:00");
  const store = await getStore();
  const settings = await store.getDefaultSettings();
  const maxDate = daysFromNow(settings.advance_window);
  if (parsed < today) {
    await ctx.reply("That date is in the past. Pick a future date.");
    return;
  }
  if (parsed > maxDate) {
    await ctx.reply(
      `That date is too far ahead. We can only book up to ${settings.advance_window} days in advance.`,
    );
    return;
  }

  const dateStr = dateString(parsed);
  ctx.session.bookingDate = dateStr;
  enterStep(ctx, "booking:time");

  const dayKey = WEEKDAYS[parsed.getDay()];
  const hours = settings.opening_hours[dayKey];
  if (!hours) {
    await ctx.reply(
      "Sorry, we're closed on that day. Pick another date.",
    );
    enterStep(ctx, "booking:date");
    return;
  }

  const niceDate = formatDateNice(parsed);
  await ctx.reply(
    `Got it — ${niceDate}. Now, what time works best for you?`,
  );
});

// ---------------------------------------------------------------------------
// Time input — accept text or pre-formatted time
// ---------------------------------------------------------------------------

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "booking:time") return next();

  const text = ctx.message.text.trim();
  // Accept HH:MM or similar
  const match = text.match(/^(\d{1,2})[:.](\d{2})$/);
  if (!match) {
    await ctx.reply("Please send the time in HH:MM format, e.g. 19:00.");
    return;
  }
  let h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  if (h > 23 || m > 59) {
    await ctx.reply("That doesn't look like a valid time. Try HH:MM, e.g. 19:00.");
    return;
  }

  const timeStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const dateStr = ctx.session.bookingDate!;
  const store = await getStore();

  // Validate against available slots
  const slots = await store.findAvailableSlots(dateStr, 1); // check minimal availability
  if (slots.length === 0) {
    await ctx.reply(
      "Sorry, there are no available slots on that day. Pick another date.",
      { reply_markup: inlineKeyboard([[
        inlineButton("⬅️ Pick a different date", "booking:start"),
      ]]) },
    );
    enterStep(ctx, "booking:date");
    return;
  }

  // Check if requested time is a valid slot
  const slotMinutes = h * 60 + m;
  const validSlot = slots.some((s) => {
    const [sh, sm] = s.split(":").map(Number);
    return sh * 60 + sm === slotMinutes;
  });

  if (!validSlot) {
    // Show available slots as buttons
    const rows = [];
    for (let i = 0; i < slots.length; i += 3) {
      rows.push(
        slots.slice(i, i + 3).map((s) =>
          inlineButton(s, `booking:slot:${s}`),
        ),
      );
    }
    rows.push([inlineButton("⬅️ Pick a different date", "booking:start")]);
    await ctx.reply(
      "That time isn't available. Here are the free slots — tap one:",
      { reply_markup: inlineKeyboard(rows) },
    );
    return;
  }

  ctx.session.bookingTime = timeStr;
  enterStep(ctx, "booking:party_size");
  await ctx.reply(
    "How many guests?",
    { reply_markup: { force_reply: true, input_field_placeholder: "e.g. 4" } },
  );
});

// Slot selection via inline button
composer.callbackQuery(/^booking:slot:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const time = ctx.callbackQuery.data.replace("booking:slot:", "");
  ctx.session.bookingTime = time;
  enterStep(ctx, "booking:party_size");
  await ctx.editMessageText(
    "How many guests?",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to time selection", "booking:start")],
      ]),
    },
  );
});

// ---------------------------------------------------------------------------
// Party size
// ---------------------------------------------------------------------------

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "booking:party_size") return next();

  const text = ctx.message.text.trim();
  const n = parseInt(text, 10);
  if (isNaN(n) || n < 1) {
    await ctx.reply("Please enter a number of guests (at least 1).");
    return;
  }
  if (n > MAX_PARTY_SIZE) {
    await ctx.reply(
      `Sorry, we can't accommodate parties larger than ${MAX_PARTY_SIZE}. ` +
      "Please enter a smaller number.",
    );
    return;
  }

  // Validate that we have a table for this party size on the chosen date/time
  const store = await getStore();
  const dateStr = ctx.session.bookingDate!;
  const timeStr = ctx.session.bookingTime!;
  const slots = await store.findAvailableSlots(dateStr, n);
  const slotMinutes =
    parseInt(timeStr.split(":")[0], 10) * 60 +
    parseInt(timeStr.split(":")[1], 10);
  const valid = slots.some((s) => {
    const [sh, sm] = s.split(":").map(Number);
    return sh * 60 + sm === slotMinutes;
  });

  if (!valid) {
    await ctx.reply(
      "Sorry, there isn't a table large enough for your party at that time. " +
      "Pick a different time or date.",
      { reply_markup: inlineKeyboard([[
        inlineButton("⬅️ Pick a different time", "booking:start"),
      ]]) },
    );
    enterStep(ctx, "booking:date");
    return;
  }

  ctx.session.bookingPartySize = n;
  enterStep(ctx, "booking:name");
  await ctx.reply(
    "What name should the booking be under?",
    { reply_markup: { force_reply: true, input_field_placeholder: "Your name" } },
  );
});

// ---------------------------------------------------------------------------
// Name
// ---------------------------------------------------------------------------

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "booking:name") return next();

  const name = ctx.message.text.trim();
  if (name.length < 1 || name.length > 100) {
    await ctx.reply("Please enter a name between 1 and 100 characters.");
    return;
  }

  ctx.session.bookingGuestName = name;
  enterStep(ctx, "booking:phone");
  await ctx.reply(
    "What's your phone number? (optional — tap Skip if you'd rather not)",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("Skip", "booking:skip_phone")],
      ]),
    },
  );
});

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

composer.callbackQuery("booking:skip_phone", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.bookingPhone = "";
  await confirmBooking(ctx);
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "booking:phone") return next();

  const phone = ctx.message.text.trim();
  ctx.session.bookingPhone = phone;
  await confirmBooking(ctx);
});

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

async function confirmBooking(ctx: Ctx): Promise<void> {
  const date = ctx.session.bookingDate!;
  const time = ctx.session.bookingTime!;
  const size = ctx.session.bookingPartySize!;
  const name = ctx.session.bookingGuestName!;
  const phone = ctx.session.bookingPhone ?? "";
  const store = await getStore();

  // Generate booking code first (independent of slot state)
  const code = await store.generateBookingCode();

  // --- Atomic check-and-assign: re-read occupancy RIGHT before saving to
  // minimize the TOCTOU window. This combines the "is slot valid" check
  // with "which specific table is free" in one synchronized read of the
  // date's booking set — a concurrent writer that happens between here and
  // saveBookingWithDateIndex will be caught by the booking-code collision
  // guard (generateBookingCode retries on collision), and if it claims the
  // last suitable table we abort rather than silently double-book.
  const settings = await store.getDefaultSettings();
  const tables = await store.listTables();
  const suitable = tables
    .filter((t) => t.capacity >= size)
    .sort((a, b) => a.capacity - b.capacity);

  if (suitable.length === 0) {
    await ctx.reply(
      "Sorry, we don't have a table large enough for your party. Please try a smaller group or another time.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("📅 Book a table", "booking:start")],
        ]),
      },
    );
    ctx.session.step = "idle";
    return;
  }

  const slotMinutes =
    parseInt(time.split(":")[0], 10) * 60 +
    parseInt(time.split(":")[1], 10);
  const startMinutes = slotMinutes;
  const endMinutes = startMinutes + settings.seat_duration;

  // Re-read occupancy right now
  const existingBookings = await store.listBookingsByDate(date);
  const confirmed = existingBookings.filter(
    (b) => b.status === "confirmed",
  );
  const occupiedTables = new Set<string>();
  for (const b of confirmed) {
    const bDt = new Date(b.datetime);
    const bStart = bDt.getHours() * 60 + bDt.getMinutes();
    const bEnd = bStart + settings.seat_duration;
    if (bStart < endMinutes && bEnd > startMinutes) {
      for (const tid of b.tables_used) {
        occupiedTables.add(tid);
      }
    }
  }

  // Check if any suitable table is free
  const freeTable = suitable.find((t) => !occupiedTables.has(t.id));
  if (!freeTable) {
    await ctx.reply(
      "Sorry, that time slot is no longer available. Please try another time or date.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("📅 Book a table", "booking:start")],
        ]),
      },
    );
    ctx.session.step = "idle";
    return;
  }

  const booking: Booking = {
    code,
    guest_name: name,
    phone,
    party_size: size,
    datetime: `${date}T${time}`,
    status: "confirmed",
    tables_used: [freeTable.id],
    user_id: ctx.from?.id,
    chat_id: ctx.chat?.id,
  };

  const assignedTableName = freeTable.name;
  await store.saveBookingWithDateIndex(booking);

  const niceDate = formatDateNice(
    new Date(date + "T12:00:00"),
  );

  const summary =
    `✅ All set! Here's your booking:\n\n` +
    `📋 Code: ${code}\n` +
    `📅 ${niceDate} at ${time}\n` +
    `👥 ${size} guest${size > 1 ? "s" : ""}\n` +
    `🪑 ${assignedTableName}\n` +
    `👤 ${name}${phone ? `\n📞 ${phone}` : ""}\n\n` +
    `We'll send you a reminder before your reservation. See you soon!`;

  await ctx.reply(summary, {
    reply_markup: inlineKeyboard([
      [inlineButton("🔄 Reschedule", `booking:reschedule:${code}`)],
      [inlineButton("Cancel booking", `booking:cancel:${code}`)],
      [inlineButton("⬅️ Back to menu", "menu:main")],
    ]),
  });

  ctx.session.step = "idle";

  // Notify owner accounts about the new booking
  try {
    await notifyOwnersNewBooking(ctx, booking, niceDate, time);
  } catch {
    // Owner notification is best-effort — never block the guest flow
  }
}

/** Send a new-booking alert to all registered owners who have opted in. */
async function notifyOwnersNewBooking(
  ctx: Ctx,
  booking: Booking,
  niceDate: string,
  time: string,
): Promise<void> {
  const store = await getStore();
  const owners = await store.listOwners();
  const alert =
    `📢 New booking!\n\n` +
    `📋 Code: ${booking.code}\n` +
    `📅 ${niceDate} at ${time}\n` +
    `👤 ${booking.guest_name}${booking.phone ? `\n📞 ${booking.phone}` : ""}\n` +
    `👥 ${booking.party_size} guests\n` +
    `🆔 Table: ${booking.tables_used.join(", ") || "Not assigned"}`;

  for (const owner of owners) {
    try {
      const prefs = await store.getOwnerPrefs(owner.telegram_id);
      if (!prefs.new_booking_alerts) continue;
      await ctx.api.sendMessage(owner.telegram_id, alert);
    } catch {
      // 403 from blocked owner — skip silently. Never abort notifications.
    }
  }
}

// ---------------------------------------------------------------------------
// Cancel booking from the confirmation
// ---------------------------------------------------------------------------

composer.callbackQuery(/^booking:cancel:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const code = ctx.callbackQuery.data.replace("booking:cancel:", "");
  const store = await getStore();
  const booking = await store.getBooking(code);
  if (!booking) {
    await ctx.editMessageText("Couldn't find that booking. It may have already been cancelled.");
    return;
  }
  // Verify ownership — only the booking creator or an owner can cancel
  const userId = ctx.from?.id;
  const isOwner = userId ? await store.isOwner(userId) : false;
  if (booking.user_id != null && userId != null && booking.user_id !== userId && !isOwner) {
    await ctx.editMessageText("Sorry, you can only cancel your own bookings.");
    return;
  }
  const updated = await store.updateBookingStatus(code, "cancelled");
  if (updated) {
    await ctx.editMessageText(
      `❌ Booking ${code} has been cancelled. Let us know if you'd like to book again!`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("📅 Book a table", "booking:start")],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
  } else {
    await ctx.editMessageText("Couldn't find that booking. It may have already been cancelled.");
  }
});

// ---------------------------------------------------------------------------
// Reschedule flow
// ---------------------------------------------------------------------------

composer.callbackQuery(/^booking:reschedule:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const code = ctx.callbackQuery.data.replace("booking:reschedule:", "");
  const store = await getStore();
  const booking = await store.getBooking(code);
  if (!booking) {
    await ctx.editMessageText("Couldn't find that booking to reschedule.");
    return;
  }

  // Verify ownership — only the booking creator or an owner can reschedule
  const userId = ctx.from?.id;
  const isOwner = userId ? await store.isOwner(userId) : false;
  if (booking.user_id != null && userId != null && booking.user_id !== userId && !isOwner) {
    await ctx.editMessageText("Sorry, you can only reschedule your own bookings.");
    return;
  }

  ctx.session.rescheduleCode = code;
  ctx.session.bookingPartySize = booking.party_size;
  ctx.session.bookingGuestName = booking.guest_name;
  ctx.session.bookingPhone = booking.phone;

  // Re-enter date selection
  enterStep(ctx, "booking:reschedule_date");
  await ctx.editMessageText(
    "Let's find a new time for your booking. What new date works? (DD/MM or DD/MM/YYYY)",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    },
  );
});

// "Pick a different date" button from reschedule time view — re-prompt date input
composer.callbackQuery("booking:reschedule_date", async (ctx) => {
  await ctx.answerCallbackQuery();
  enterStep(ctx, "booking:reschedule_date");
  await ctx.editMessageText(
    "Let's find a new time for your booking. What new date works? (DD/MM or DD/MM/YYYY)",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    },
  );
});

// Reschedule date input (same as booking:date but applies to reschedule)
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "booking:reschedule_date") return next();

  const text = ctx.message.text.trim();
  const parsed = parseDateInput(text);
  if (!parsed) {
    await ctx.reply(
      "Couldn't recognise that date. Please use DD/MM format, e.g. 15/07.",
    );
    return;
  }

  const today = new Date(todayString() + "T12:00:00");
  const store = await getStore();
  const settings = await store.getDefaultSettings();
  const maxDate = daysFromNow(settings.advance_window);
  if (parsed < today) {
    await ctx.reply("That date is in the past. Pick a future date.");
    return;
  }
  if (parsed > maxDate) {
    await ctx.reply(
      `That date is too far ahead. We can only book up to ${settings.advance_window} days in advance.`,
    );
    return;
  }

  const dateStr = dateString(parsed);
  ctx.session.bookingDate = dateStr;

  // Check if the restaurant is open on that day
  const dayKey = WEEKDAYS[parsed.getDay()];
  const hours = settings.opening_hours[dayKey];
  if (!hours) {
    await ctx.reply(
      "Sorry, we're closed on that day. Pick another date.",
    );
    enterStep(ctx, "booking:reschedule_date");
    return;
  }

  enterStep(ctx, "booking:reschedule_time");

  const size = ctx.session.bookingPartySize ?? 1;
  const slots = await store.findAvailableSlots(dateStr, size);

  if (slots.length === 0) {
    await ctx.reply(
      "Sorry, no tables are available on that date for your party size. Pick another date.",
    );
    enterStep(ctx, "booking:reschedule_date");
    return;
  }

  const niceDate = formatDateNice(parsed);
  const rows = [];
  for (let i = 0; i < slots.length; i += 3) {
    rows.push(
      slots.slice(i, i + 3).map((s) => inlineButton(s, `booking:reschedule_slot:${s}`)),
    );
  }
  rows.push([inlineButton("⬅️ Pick a different date", "booking:reschedule_date")]);
  await ctx.reply(
    `${niceDate} — here are the available slots. Tap one:`,
    { reply_markup: inlineKeyboard(rows) },
  );
});

// Reschedule slot tap — validates availability and reassigns table
composer.callbackQuery(/^booking:reschedule_slot:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const time = ctx.callbackQuery.data.replace("booking:reschedule_slot:", "");
  const code = ctx.session.rescheduleCode!;
  const date = ctx.session.bookingDate!;
  const size = ctx.session.bookingPartySize!;
  const store = await getStore();

  // Validate the slot is still available for this party size
  const slots = await store.findAvailableSlots(date, size);
  const slotMinutes =
    parseInt(time.split(":")[0], 10) * 60 +
    parseInt(time.split(":")[1], 10);
  const valid = slots.some((s) => {
    const [sh, sm] = s.split(":").map(Number);
    return sh * 60 + sm === slotMinutes;
  });

  if (!valid) {
    await ctx.editMessageText(
      "Sorry, that time is no longer available. Please pick another slot.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("⬅️ Back to time selection", "booking:reschedule_date")],
        ]),
      },
    );
    return;
  }

  const booking = await store.getBooking(code);
  if (!booking) {
    await ctx.editMessageText("Couldn't find your booking. Please start again.");
    return;
  }

  // Verify ownership — only the booking creator or an owner can reschedule
  const userId = ctx.from?.id;
  const isOwner = userId ? await store.isOwner(userId) : false;
  if (booking.user_id != null && userId != null && booking.user_id !== userId && !isOwner) {
    await ctx.editMessageText("Sorry, you can only reschedule your own bookings.");
    return;
  }

  // Track the OLD date so we can remove the index after updating
  const oldDate = booking.datetime.substring(0, 10);

  // Assign a suitable table for the new slot — re-check actual occupancy
  const settings = await store.getDefaultSettings();
  const tables = await store.listTables();
  const suitable = tables
    .filter((t) => t.capacity >= size)
    .sort((a, b) => a.capacity - b.capacity);

  const existingBookings = await store.listBookingsByDate(date);
  const confirmed = existingBookings.filter(
    (b) => b.status === "confirmed" || b.status === "completed",
  );
  const startMinutes = slotMinutes;
  const endMinutes = startMinutes + settings.seat_duration;
  const occupiedTables = new Set<string>();
  for (const b of confirmed) {
    // Don't count the booking we're rescheduling
    if (b.code === code) continue;
    const bDt = new Date(b.datetime);
    const bStart = bDt.getHours() * 60 + bDt.getMinutes();
    const bEnd = bStart + settings.seat_duration;
    if (bStart < endMinutes && bEnd > startMinutes) {
      for (const tid of b.tables_used) {
        occupiedTables.add(tid);
      }
    }
  }

  const freeTable = suitable.find((t) => !occupiedTables.has(t.id));
  if (!freeTable) {
    await ctx.editMessageText(
      "Sorry, that time slot is no longer available. Please try another time or date.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("📅 Book a table", "booking:start")],
          [inlineButton("⬅️ Back to time selection", "booking:reschedule_date")],
        ]),
      },
    );
    ctx.session.step = "idle";
    return;
  }

  const freeTableName = freeTable.name;
  booking.datetime = `${date}T${time}`;
  booking.status = "confirmed";
  booking.tables_used = [freeTable.id];
  // Clear reminded_at so the reminder sweep re-evaluates the new datetime
  booking.reminded_at = undefined;
  // Remove old date index before saving with new date index
  await store.removeBookingDateIndex(booking.code, oldDate);
  await store.saveBookingWithDateIndex(booking);

  const niceDate = formatDateNice(new Date(date + "T12:00:00"));
  await ctx.editMessageText(
    `🔄 Rescheduled! Your booking ${code} is now:\n\n` +
    `📅 ${niceDate} at ${time}\n` +
    `👥 ${booking.party_size} guest${booking.party_size > 1 ? "s" : ""}\n` +
    `🪑 ${freeTableName}\n`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("📅 Back to menu", "menu:main")],
      ]),
    },
  );

  ctx.session.step = "idle";
});

// ---------------------------------------------------------------------------
// Own bookings view (from confirmation / main menu)
// ---------------------------------------------------------------------------

registerMainMenuItem({
  label: "📋 My bookings",
  data: "booking:my",
  order: 20,
});

composer.callbackQuery("booking:my", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.editMessageText("Couldn't identify you. Try /start.");
    return;
  }

  const store = await getStore();
  const bookings = await store.listBookingsByUser(userId);
  const active = bookings.filter(
    (b) => b.status === "confirmed" && b.datetime >= todayString(),
  );

  if (active.length === 0) {
    await ctx.editMessageText(
      "📋 You have no upcoming bookings.\n\nTap 📅 Book a table to make one!",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("📅 Book a table", "booking:start")],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  let msg = "📋 Your upcoming bookings:\n\n";
  for (const b of active) {
    const dt = new Date(b.datetime);
    const niceDate = formatDateNice(dt);
    const hh = String(dt.getHours()).padStart(2, "0");
    const mm = String(dt.getMinutes()).padStart(2, "0");
    msg += `• ${b.code} — ${niceDate} at ${hh}:${mm}, ${b.party_size} guests\n`;
  }

  await ctx.editMessageText(msg, {
    reply_markup: inlineKeyboard([
      [inlineButton("📅 Book a table", "booking:start")],
      [inlineButton("⬅️ Back to menu", "menu:main")],
    ]),
  });
});

export default composer;