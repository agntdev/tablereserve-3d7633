import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { setClock } from "../src/clock.js";
import { sendPendingReminders } from "../src/handlers/reminder.js";
import { setStore, getStore } from "../src/store.js";

describe("automated reminder delivery", () => {
  let capturedMessages: Array<{ chatId: number; text: string }>;

  beforeEach(async () => {
    capturedMessages = [];

    // Reset store before each test
    setStore(null);

    // Set clock to a fixed time: 2026-07-15 10:00:00
    setClock(() => new Date("2026-07-15T10:00:00Z"));

    const store = await getStore();
    const settings = await store.getDefaultSettings();
    settings.reminder_lead_time = 60; // 60 minutes

    // Create a booking happening at 2026-07-15 10:45:00 (45 minutes from now —
    // less than the 60-min lead time, so reminder should be due).
    const bookingDue = {
      code: "RMTEST1",
      guest_name: "Alice",
      phone: "+1234567890",
      party_size: 4,
      datetime: "2026-07-15T10:45:00",
      status: "confirmed" as const,
      tables_used: ["T2"],
      user_id: 42,
      chat_id: 999,
    };

    // Create a booking happening at 2026-07-15 13:00:00 (3 hours from now —
    // more than the 60-min lead time, so reminder NOT due yet).
    const bookingFuture = {
      code: "RMTEST2",
      guest_name: "Bob",
      phone: "+9876543210",
      party_size: 2,
      datetime: "2026-07-15T13:00:00",
      status: "confirmed" as const,
      tables_used: ["T1"],
      user_id: 43,
      chat_id: 998,
    };

    // Create a booking with reminded_at already set — reminder already sent
    const bookingAlreadyReminded = {
      code: "RMTEST3",
      guest_name: "Carol",
      phone: "",
      party_size: 3,
      datetime: "2026-07-15T10:30:00",
      status: "confirmed" as const,
      tables_used: ["T3"],
      user_id: 44,
      chat_id: 997,
      reminded_at: "2026-07-15T09:30:00Z",
    };

    // Create a cancelled booking that should NOT get a reminder
    const bookingCancelled = {
      code: "RMTEST4",
      guest_name: "Dave",
      phone: "",
      party_size: 5,
      datetime: "2026-07-15T10:30:00",
      status: "cancelled" as const,
      tables_used: ["T4"],
      user_id: 45,
      chat_id: 996,
    };

    for (const b of [bookingDue, bookingFuture, bookingAlreadyReminded, bookingCancelled]) {
      await store.saveBookingWithDateIndex(b);
    }
  });

  afterEach(() => {
    setClock(() => new Date());
    setStore(null);
  });

  it("sends reminders for due bookings and marks them as reminded", async () => {
    const fakeApi = {
      sendMessage: async (chatId: number, text: string) => {
        capturedMessages.push({ chatId, text });
        return { ok: true, result: { message_id: 1, date: 0, chat: { id: chatId, type: "private" as const } } };
      },
    };

    const sent = await sendPendingReminders(fakeApi as any);

    // Should have sent 1 reminder (Alice's, the only fully-due booking)
    expect(sent).toBe(1);
    expect(capturedMessages.length).toBe(1);
    expect(capturedMessages[0].chatId).toBe(999);
    expect(capturedMessages[0].text).toMatch(/RMTEST1/);
    expect(capturedMessages[0].text).toMatch(/Reminder/i);

    // Verify the booking was marked as reminded
    const store = await getStore();
    const updated = await store.getBooking("RMTEST1");
    expect(updated?.reminded_at).toBeTruthy();
  });

  it("does not send duplicate reminders when already reminded", async () => {
    const fakeApi = {
      sendMessage: async (chatId: number, text: string) => {
        capturedMessages.push({ chatId, text });
        return { ok: true, result: { message_id: 1, date: 0, chat: { id: chatId, type: "private" as const } } };
      },
    };

    await sendPendingReminders(fakeApi as any);
    expect(capturedMessages.length).toBe(1); // Alice only

    // Run again — should not send anything new (Alice already reminded)
    await sendPendingReminders(fakeApi as any);
    expect(capturedMessages.length).toBe(1); // Still only Alice
  });

  it("handles 403 gracefully without crashing the sweep", async () => {
    const store = await getStore();
    // Seed a booking with a chat_id that will fail: one that 403s
    const bookingBlocked = {
      code: "RMTEST5",
      guest_name: "BlockedUser",
      phone: "",
      party_size: 2,
      datetime: "2026-07-15T10:30:00",
      status: "confirmed" as const,
      tables_used: ["T1"],
      user_id: 99,
      chat_id: 555, // user started bot but then blocked it
    };
    await store.saveBookingWithDateIndex(bookingBlocked);

    const fakeApi = {
      sendMessage: async (chatId: number, text: string) => {
        if (chatId === 555) {
          const err = new Error("bot was blocked by the user") as any;
          err.statusCode = 403;
          throw err;
        }
        capturedMessages.push({ chatId, text });
        return { ok: true, result: { message_id: 1, date: 0, chat: { id: chatId, type: "private" as const } } };
      },
    };

    // Should not throw despite 403
    const sent = await sendPendingReminders(fakeApi as any);
    expect(sent).toBe(1); // Alice still gets hers
  });
});