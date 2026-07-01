// Booking handler — full guest booking flow with date/time/party-size selection,
// confirmation, rescheduling, and cancellation. Button-first: reachable from the
// /start main menu via the "Book a table" button.

import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
  confirmKeyboard,
} from "../toolkit/index.js";
import { getStore, type Booking } from "../storage.js";

// ─── Register main menu buttons ──────────────────────────────────────────

registerMainMenuItem({ label: "📅 Book a table", data: "booking:start", order: 10 });
registerMainMenuItem({ label: "📋 My bookings", data: "booking:my", order: 20 });

const composer = new Composer<Ctx>();

// ─── Shared helpers ──────────────────────────────────────────────────────

const BACK_MENU = inlineButton("⬅️ Back to menu", "menu:main");
const CANCEL = inlineButton("Cancel", "booking:cancel");
const BACK_BTN = inlineButton("⬅️ Back", "booking:back");

function backOnly(): ReturnType<typeof inlineKeyboard> {
  return inlineKeyboard([[BACK_MENU]]);
}

function cancelRow(): ReturnType<typeof inlineKeyboard> {
  return inlineKeyboard([[BACK_BTN, CANCEL]]);
}

// ─── Cancel flow entirely ────────────────────────────────────────────────

composer.callbackQuery("booking:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "idle";
  delete ctx.session.bookingDate;
  delete ctx.session.bookingTime;
  delete ctx.session.bookingPartySize;
  delete ctx.session.bookingGuestName;
  delete ctx.session.bookingPhone;
  delete ctx.session.bookingCode;
  await ctx.editMessageText(
    "Booking cancelled. Tap /start to open the menu whenever you're ready.",
    { reply_markup: inlineKeyboard([[BACK_MENU]]) },
  );
});

// ─── Back navigation ─────────────────────────────────────────────────────

composer.callbackQuery("booking:back", async (ctx) => {
  await ctx.answerCallbackQuery();
  const step = ctx.session.step;

  if (step === "booking:date" || !step) {
    ctx.session.step = "idle";
    await ctx.editMessageText("👋 Welcome! Tap a button below to get started.", {
      reply_markup: inlineKeyboard([[BACK_MENU]]),
    });
    return;
  }
  if (step === "booking:time") {
    ctx.session.step = "booking:date";
    await showDateSelection(ctx);
    return;
  }
  if (step === "booking:party_size") {
    ctx.session.step = "booking:time";
    await showTimeSlots(ctx, ctx.session.bookingDate!);
    return;
  }
  if (step === "booking:name") {
    ctx.session.step = "booking:party_size";
    await showPartySizeSelection(ctx);
    return;
  }
  if (step === "booking:phone") {
    ctx.session.step = "booking:name";
    await showNameInput(ctx);
    return;
  }
  if (step === "booking:confirm") {
    ctx.session.step = "booking:phone";
    await showPhoneInput(ctx);
    return;
  }
  // Default: back to menu
  ctx.session.step = "idle";
  await ctx.editMessageText("👋 Welcome! Tap a button below to get started.", {
    reply_markup: inlineKeyboard([[BACK_MENU]]),
  });
});

// ─── Start booking flow ──────────────────────────────────────────────────

composer.callbackQuery("booking:start", async (ctx) => {
  await ctx.answerCallbackQuery();

  // If there's a reschedule code, preserve it
  if (!ctx.session.bookingCode) {
    delete ctx.session.bookingDate;
    delete ctx.session.bookingTime;
    delete ctx.session.bookingPartySize;
    delete ctx.session.bookingGuestName;
    delete ctx.session.bookingPhone;
  }

  ctx.session.step = "booking:date";
  await showDateSelection(ctx);
});

// ─── Step 1: Date selection ──────────────────────────────────────────────

async function showDateSelection(ctx: Ctx): Promise<void> {
  ctx.session.step = "booking:date";

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const buttons: ReturnType<typeof inlineButton>[] = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const ds = d.toISOString().slice(0, 10);
    const dayName = dayNames[d.getDay()];
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const label = i === 0 ? `Today (${month}/${day})` : `${dayName} ${month}/${day}`;
    buttons.push(inlineButton(label, `booking:date:${ds}`));
  }

  const rows: ReturnType<typeof inlineButton>[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  rows.push([CANCEL]);

  await ctx.editMessageText(
    "📅 When would you like to come in?\n\nPick a date below and we'll show you available times.",
    { reply_markup: inlineKeyboard(rows) },
  );
}

composer.callbackQuery(/^booking:date:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const date = ctx.match[1];
  ctx.session.bookingDate = date;
  ctx.session.step = "booking:time";
  await showTimeSlots(ctx, date);
});

// ─── Step 2: Time slot selection ─────────────────────────────────────────

async function showTimeSlots(ctx: Ctx, date: string): Promise<void> {
  const store = getStore();
  const slots = await store.getAvailableSlots(date);

  if (slots.length === 0) {
    await ctx.editMessageText(
      "Sorry, there are no available slots on that date.\n\n" +
        "Try picking a different day — we have plenty of other options!",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("🔙 Pick another date", "booking:date")],
          [CANCEL],
        ]),
      },
    );
    return;
  }

  const timeButtons = slots.slice(0, 12).map((t) => inlineButton(`🕐 ${t}`, `booking:time:${t}`));
  const rows: ReturnType<typeof inlineButton>[][] = [];
  for (let i = 0; i < timeButtons.length; i += 3) {
    rows.push(timeButtons.slice(i, i + 3));
  }
  rows.push([inlineButton("🔙 Pick another date", "booking:date")]);
  rows.push([CANCEL]);

  await ctx.editMessageText(`Available times for ${date}:\nTap a slot to select it.`, {
    reply_markup: inlineKeyboard(rows),
  });
}

composer.callbackQuery(/^booking:time:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.bookingTime = ctx.match[1];
  ctx.session.step = "booking:party_size";
  await showPartySizeSelection(ctx);
});

// ─── Step 3: Party size ──────────────────────────────────────────────────

async function showPartySizeSelection(ctx: Ctx): Promise<void> {
  const store = getStore();
  const result = await store.validatePartySize(1);

  const sizeButtons = [];
  for (let s = result.min; s <= result.max; s++) {
    sizeButtons.push(inlineButton(`${s}`, `booking:party:${s}`));
  }

  const rows: ReturnType<typeof inlineButton>[][] = [];
  for (let i = 0; i < sizeButtons.length; i += 4) {
    rows.push(sizeButtons.slice(i, i + 4));
  }
  rows.push([CANCEL]);

  await ctx.editMessageText(
    `👥 How many guests?\n\nWe can accommodate parties of ${result.min} to ${result.max}. Tap the number below.`,
    { reply_markup: inlineKeyboard(rows) },
  );
}

composer.callbackQuery(/^booking:party:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const size = parseInt(ctx.match[1], 10);
  const store = getStore();
  const result = await store.validatePartySize(size);

  if (!result.valid) {
    await ctx.editMessageText(
      `Sorry, we can only accommodate ${result.min} to ${result.max} guests per booking. Please pick a different size.`,
      { reply_markup: inlineKeyboard([[inlineButton("🔙 Try again", "booking:party_size")]]) },
    );
    return;
  }

  ctx.session.bookingPartySize = size;
  ctx.session.step = "booking:name";
  await showNameInput(ctx);
});

// ─── Step 4: Guest name (free-form text) ─────────────────────────────────

async function showNameInput(ctx: Ctx): Promise<void> {
  await ctx.editMessageText(
    "What name should the reservation be under?\n\nJust type your name (or your party's name). It helps us greet you when you arrive!",
    { reply_markup: cancelRow() },
  );
}

// ─── Step 5: Phone (free-form text or skip) ──────────────────────────────

async function showPhoneInput(ctx: Ctx): Promise<void> {
  await ctx.editMessageText(
    "📱 Got a contact number?\n\nWe'll only use it if we need to reach you about your booking. Or tap \"Skip\" to continue without one.",
    {
      reply_markup: inlineKeyboard([
        [BACK_BTN, CANCEL],
        [inlineButton("Skip — no phone", "booking:phone:skip")],
      ]),
    },
  );
}

composer.callbackQuery("booking:phone:skip", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.bookingPhone = "";
  ctx.session.step = "booking:confirm";
  await showBookingConfirm(ctx);
});

// ─── Handle free-form text (name & phone input) ──────────────────────────

composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.step;
  if (!step || !step.startsWith("booking:")) return next();

  const text = ctx.message.text.trim();

  if (step === "booking:name") {
    if (text.length < 1) {
      await ctx.reply("Please enter a name, or tap Cancel to stop.");
      return;
    }
    ctx.session.bookingGuestName = text;
    ctx.session.step = "booking:phone";
    await showPhoneInputAsReply(ctx);
    return;
  }

  if (step === "booking:phone") {
    ctx.session.bookingPhone = text;
    ctx.session.step = "booking:confirm";
    await showBookingConfirmViaReply(ctx);
    return;
  }

  return next();
});

// Reply-based versions for text input (no message to edit)
async function showPhoneInputAsReply(ctx: Ctx): Promise<void> {
  await ctx.reply(
    "📱 Got a contact number?\n\n" +
      "We'll only use it if we need to reach you about your booking. Or tap \"Skip\" to continue without one.",
    {
      reply_markup: inlineKeyboard([
        [BACK_BTN, CANCEL],
        [inlineButton("Skip — no phone", "booking:phone:skip")],
      ]),
    },
  );
}

async function showBookingConfirmViaReply(ctx: Ctx): Promise<void> {
  const date = ctx.session.bookingDate;
  const time = ctx.session.bookingTime;
  const size = ctx.session.bookingPartySize;
  const name = ctx.session.bookingGuestName || "Guest";
  const phone = ctx.session.bookingPhone || "(not provided)";

  const text =
    "Please confirm your booking:\n\n" +
    `📅 Date: ${date}\n` +
    `🕐 Time: ${time}\n` +
    `👥 Guests: ${size}\n` +
    `👤 Name: ${name}\n` +
    `📱 Phone: ${phone}`;

  await ctx.reply(text, {
    reply_markup: inlineKeyboard([
      [inlineButton("✅ Confirm booking", "booking:confirm:yes")],
      [inlineButton("🔄 Start over", "booking:start")],
      [CANCEL],
    ]),
  });
}

// ─── Step 6: Confirmation ────────────────────────────────────────────────

async function showBookingConfirm(ctx: Ctx): Promise<void> {
  const date = ctx.session.bookingDate;
  const time = ctx.session.bookingTime;
  const size = ctx.session.bookingPartySize;
  const name = ctx.session.bookingGuestName || "Guest";
  const phone = ctx.session.bookingPhone || "(not provided)";
  const reschedule = ctx.session.bookingCode;

  const text =
    (reschedule ? "🔄 Rescheduling your booking\n\n" : "") +
    "Please confirm your booking:\n\n" +
    `📅 Date: ${date}\n` +
    `🕐 Time: ${time}\n` +
    `👥 Guests: ${size}\n` +
    `👤 Name: ${name}\n` +
    `📱 Phone: ${phone}`;

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([
      [inlineButton("✅ Confirm booking", "booking:confirm:yes")],
      [inlineButton("🔄 Start over", "booking:start")],
      [CANCEL],
    ]),
  });
}

composer.callbackQuery("booking:confirm:yes", async (ctx) => {
  await ctx.answerCallbackQuery();
  const store = getStore();

  const date = ctx.session.bookingDate!;
  const time = ctx.session.bookingTime!;
  const size = ctx.session.bookingPartySize!;
  const name = ctx.session.bookingGuestName || "Guest";
  const phone = ctx.session.bookingPhone || "";
  const userId = ctx.from?.id ?? 0;

  if (!date || !time || !size) {
    await ctx.editMessageText("Something went wrong — your session may have expired. Tap /start to begin again.", {
      reply_markup: inlineKeyboard([[BACK_MENU]]),
    });
    return;
  }

  // Double-check slot still available
  const available = await store.getAvailableSlots(date);
  if (!available.includes(time)) {
    await ctx.editMessageText(
      "Sorry, that time slot was just taken! Let's find another one.",
      {
        reply_markup: inlineKeyboard([[inlineButton("🔍 See available slots", `booking:date:${date}`)]]),
      },
    );
    return;
  }

  // Find a table
  const table = await store.findBestTable(date, time, size);
  if (!table) {
    await ctx.editMessageText(
      "Sorry, we couldn't find a suitable table for your party size at that time. Please try another time or date.",
      {
        reply_markup: inlineKeyboard([[inlineButton("🔍 Pick another time", `booking:date:${date}`)]]),
      },
    );
    return;
  }

  // Generate code and persist
  const code = await store.generateBookingCode();
  const now = new Date().toISOString();
  const booking: Booking = {
    code,
    guestName: name,
    phone,
    partySize: size,
    date,
    time,
    datetime: `${date}T${time}:00`,
    status: "confirmed",
    tablesUsed: [table.id],
    guestChatId: userId,
    createdAt: now,
  };

  await store.createBooking(booking);

  // If rescheduling, cancel old booking
  const oldCode = ctx.session.bookingCode;
  if (oldCode) {
    const old = await store.getBooking(oldCode);
    if (old) {
      old.status = "cancelled";
      await store.updateBooking(old);
    }
    delete ctx.session.bookingCode;
  }

  ctx.session.step = "booking:done";

  const guestWord = size === 1 ? "guest" : "guests";
  const text =
    "✅ Booking confirmed!\n\n" +
    `Your code: ${code}\n` +
    `📅 ${date} at ${time}\n` +
    `👥 ${size} ${guestWord}\n` +
    `🪑 ${table.name}\n\n` +
    "We'll send you a reminder before your reservation. See you soon!";

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([
      [inlineButton("🔄 Reschedule", `reschedule:${code}`)],
      [inlineButton("❌ Cancel booking", `cancel:booking:${code}`)],
      [BACK_MENU],
    ]),
  });
});

// ─── Reschedule flow ─────────────────────────────────────────────────────

composer.callbackQuery(/^reschedule:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const code = ctx.match[1];
  const store = getStore();
  const booking = await store.getBooking(code);

  if (!booking || booking.status !== "confirmed") {
    await ctx.editMessageText(
      "Couldn't find that booking to reschedule. It may have been cancelled.",
      { reply_markup: inlineKeyboard([[BACK_MENU]]) },
    );
    return;
  }

  // Pre-fill session with existing data
  ctx.session.bookingCode = code;
  ctx.session.bookingDate = booking.date;
  ctx.session.bookingTime = booking.time;
  ctx.session.bookingPartySize = booking.partySize;
  ctx.session.bookingGuestName = booking.guestName;
  ctx.session.bookingPhone = booking.phone;
  ctx.session.step = "booking:date";

  await ctx.editMessageText(`Let's find a new time for ${code}. Pick a new date:`, {
    reply_markup: inlineKeyboard([[CANCEL]]),
  });
  await showDateSelection(ctx);
});

// ─── Cancel booking ──────────────────────────────────────────────────────

composer.callbackQuery(/^cancel:booking:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const code = ctx.match[1];
  const store = getStore();
  const booking = await store.getBooking(code);

  if (!booking) {
    await ctx.editMessageText(
      "Couldn't find that booking. It may have already been cancelled.",
      { reply_markup: inlineKeyboard([[BACK_MENU]]) },
    );
    return;
  }

  ctx.session.bookingCode = code;

  await ctx.editMessageText(
    `Are you sure you want to cancel booking ${code}?\n\n` +
      `📅 ${booking.date} at ${booking.time}\n` +
      `👥 ${booking.partySize} guest${booking.partySize !== 1 ? "s" : ""}\n\n` +
      "This can't be undone.",
    {
      reply_markup: confirmKeyboard(`cancel:confirm:${code}`, {
        yes: "✅ Yes, cancel",
        no: "🔙 Keep it",
      }),
    },
  );
});

composer.callbackQuery(/^cancel:confirm:(.+):(yes|no)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const code = ctx.match[1];
  const action = ctx.match[2];

  const store = getStore();
  const booking = await store.getBooking(code);

  if (!booking) {
    await ctx.editMessageText("Booking not found.", { reply_markup: inlineKeyboard([[BACK_MENU]]) });
    return;
  }

  if (action === "no") {
    await showBookingDetail(ctx, code);
    return;
  }

  booking.status = "cancelled";
  await store.updateBooking(booking);

  await ctx.editMessageText(
    `Booking ${code} has been cancelled.\n\nIf you'd like to book again, tap the button below.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("📅 Book a table", "booking:start")],
        [BACK_MENU],
      ]),
    },
  );
});

// ─── My bookings ─────────────────────────────────────────────────────────

composer.callbackQuery("booking:my", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id ?? 0;
  const store = getStore();
  const bookings = await store.getBookingsForGuest(userId);
  const active = bookings.filter((b) => b.status === "confirmed");

  if (active.length === 0) {
    await ctx.editMessageText(
      "You don't have any upcoming bookings.\n\nTap 📅 Book a table to make one!",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("📅 Book a table", "booking:start")],
          [BACK_MENU],
        ]),
      },
    );
    return;
  }

  const lines = active.map(
    (b, i) =>
      `${i + 1}. 📅 ${b.date} at ${b.time} — ${b.partySize} guest${b.partySize !== 1 ? "s" : ""} (${b.code})`,
  );

  const buttons = active.map((b) => [
    inlineButton(`${b.date} ${b.time} (${b.code})`, `booking:detail:${b.code}`),
  ]);
  buttons.push([BACK_MENU]);

  await ctx.editMessageText(
    "📋 Your upcoming bookings:\n\n" + lines.join("\n") + "\n\nTap a booking below to manage it.",
    { reply_markup: inlineKeyboard(buttons) },
  );
});

composer.callbackQuery(/^booking:detail:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showBookingDetail(ctx, ctx.match[1]);
});

// ─── Shared booking detail view ──────────────────────────────────────────

async function showBookingDetail(ctx: Ctx, code: string): Promise<void> {
  const store = getStore();
  const booking = await store.getBooking(code);
  if (!booking) {
    await ctx.editMessageText("Booking not found.", { reply_markup: inlineKeyboard([[BACK_MENU]]) });
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
    `🪑 ${booking.tablesUsed.join(", ")}`;

  const rows: ReturnType<typeof inlineButton>[][] = [];
  if (booking.status === "confirmed") {
    rows.push([inlineButton("🔄 Reschedule", `reschedule:${code}`)]);
    rows.push([inlineButton("❌ Cancel", `cancel:booking:${code}`)]);
  }
  rows.push([BACK_MENU]);

  await ctx.editMessageText(text, { reply_markup: inlineKeyboard(rows) });
}

export default composer;