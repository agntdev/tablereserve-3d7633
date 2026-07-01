// Domain data storage — durable persistence for restaurant settings, tables, bookings,
// and owner accounts. Uses an abstract StorageAdapter<string> so it works identically
// with in-memory storage (dev/test) or Redis (production).
//
// CRITICAL: Never enumerate keyspace (no KEYS/SCAN/readAll). Maintain explicit index
// records for collections and read through those indices.

import type { StorageAdapter } from "grammy";
import { MemorySessionStorage } from "./toolkit/session/memory.js";

// ─── Type definitions ────────────────────────────────────────────────────

export interface RestaurantSettings {
  openingHours: Record<string, string>; // day-of-week "0"-"6" → "09:00-22:00" or "" for closed
  seatDurationMinutes: number;
  advanceWindowDays: number;
  reminderLeadMinutes: number;
  maxPartySize: number;
  minPartySize: number;
}

export interface Table {
  id: string;
  name: string;
  capacity: number;
}

export interface Booking {
  code: string;
  guestName: string;
  phone: string;
  partySize: number;
  date: string;          // YYYY-MM-DD
  time: string;          // HH:mm
  datetime: string;      // ISO string
  status: "confirmed" | "cancelled" | "no_show" | "completed";
  tablesUsed: string[];  // table IDs
  guestChatId: number;   // Telegram chat ID
  createdAt: string;     // ISO string
}

export interface OwnerAccount {
  telegramId: number;
  permissions: "owner" | "staff";
}

// ─── Defaults ────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS: RestaurantSettings = {
  openingHours: {
    "0": "",     // Sunday — closed
    "1": "09:00-22:00",
    "2": "09:00-22:00",
    "3": "09:00-22:00",
    "4": "09:00-22:00",
    "5": "09:00-22:00",
    "6": "09:00-22:00",
  },
  seatDurationMinutes: 90,
  advanceWindowDays: 30,
  reminderLeadMinutes: 120,
  maxPartySize: 12,
  minPartySize: 1,
};

export const DEFAULT_TABLES: Table[] = [
  { id: "t1", name: "Table 1", capacity: 2 },
  { id: "t2", name: "Table 2", capacity: 2 },
  { id: "t3", name: "Table 3", capacity: 4 },
  { id: "t4", name: "Table 4", capacity: 4 },
  { id: "t5", name: "Table 5", capacity: 6 },
  { id: "t6", name: "Table 6", capacity: 6 },
  { id: "t7", name: "Table 7", capacity: 8 },
  { id: "t8", name: "Table 8", capacity: 8 },
];

// ─── Domain storage class ────────────────────────────────────────────────

export class DomainStore {
  constructor(
    /** The underlying key-value adapter. */
    public store: StorageAdapter<string>,
  ) {}

  // ─── Restaurant settings ──────────────────────────────────────────────

  async getSettings(): Promise<RestaurantSettings> {
    const raw = await this.store.read("settings");
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    return JSON.parse(raw) as RestaurantSettings;
  }

  async saveSettings(s: RestaurantSettings): Promise<void> {
    await this.store.write("settings", JSON.stringify(s));
  }

  // ─── Tables ───────────────────────────────────────────────────────────

  async getTables(): Promise<Table[]> {
    const raw = await this.store.read("tables");
    if (!raw) return structuredClone(DEFAULT_TABLES);
    return JSON.parse(raw) as Table[];
  }

  async saveTables(tables: Table[]): Promise<void> {
    await this.store.write("tables", JSON.stringify(tables));
  }

  // ─── Booking codes counter ────────────────────────────────────────────

  private async nextBookingSeq(): Promise<number> {
    const raw = await this.store.read("booking:counter");
    const next = (raw ? parseInt(raw, 10) || 0 : 0) + 1;
    await this.store.write("booking:counter", String(next));
    return next;
  }

  // ─── Bookings ─────────────────────────────────────────────────────────

  async createBooking(b: Booking): Promise<void> {
    await this.store.write(`booking:${b.code}`, JSON.stringify(b));

    // Index: date → [codes]
    const dateCodes = await this.readIndex(`date:${b.date}`);
    dateCodes.push(b.code);
    await this.writeIndex(`date:${b.date}`, dateCodes);

    // Index: guest → [codes]
    const guestCodes = await this.readIndex(`guest:${b.guestChatId}`);
    guestCodes.push(b.code);
    await this.writeIndex(`guest:${b.guestChatId}`, guestCodes);

    // Index: date:time → [codes]
    const dtCodes = await this.readIndex(`dt:${b.date}:${b.time}`);
    dtCodes.push(b.code);
    await this.writeIndex(`dt:${b.date}:${b.time}`, dtCodes);
  }

  async updateBooking(b: Booking): Promise<void> {
    await this.store.write(`booking:${b.code}`, JSON.stringify(b));
  }

  async getBooking(code: string): Promise<Booking | undefined> {
    const raw = await this.store.read(`booking:${code}`);
    if (!raw) return undefined;
    return JSON.parse(raw) as Booking;
  }

  async getBookingsForDate(date: string): Promise<Booking[]> {
    const codes = await this.readIndex(`date:${date}`);
    return this.resolveBookings(codes);
  }

  async getBookingsForGuest(chatId: number): Promise<Booking[]> {
    const codes = await this.readIndex(`guest:${chatId}`);
    return this.resolveBookings(codes);
  }

  async getBookingsForTime(date: string, time: string): Promise<Booking[]> {
    const codes = await this.readIndex(`dt:${date}:${time}`);
    return this.resolveBookings(codes);
  }

  async getUpcomingBookings(): Promise<Booking[]> {
    const settings = await this.getSettings();
    const allCodes: string[] = [];
    for (let i = 0; i < settings.advanceWindowDays; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      const ds = d.toISOString().slice(0, 10);
      const codes = await this.readIndex(`date:${ds}`);
      allCodes.push(...codes);
    }
    return this.resolveBookings(allCodes);
  }

  async getActiveBookingsForDate(date: string): Promise<Booking[]> {
    const all = await this.getBookingsForDate(date);
    return all.filter((b) => b.status === "confirmed");
  }

  async generateBookingCode(): Promise<string> {
    const seq = await this.nextBookingSeq();
    const ts = Date.now().toString(36).toUpperCase().slice(-4);
    const sn = seq.toString(36).toUpperCase().padStart(3, "0").slice(-3);
    return `BK-${ts}${sn}`;
  }

  // ─── Owner accounts ───────────────────────────────────────────────────

  async getOwnerAccounts(): Promise<OwnerAccount[]> {
    const raw = await this.store.read("owner_accounts");
    if (!raw) return [];
    return JSON.parse(raw) as OwnerAccount[];
  }

  async setOwnerAccounts(accounts: OwnerAccount[]): Promise<void> {
    await this.store.write("owner_accounts", JSON.stringify(accounts));
  }

  async addOwnerAccount(acc: OwnerAccount): Promise<void> {
    const accounts = await this.getOwnerAccounts();
    accounts.push(acc);
    await this.setOwnerAccounts(accounts);
  }

  async isOwner(telegramId: number): Promise<boolean> {
    const accounts = await this.getOwnerAccounts();
    return accounts.some((a) => a.telegramId === telegramId);
  }

  // ─── Capacity / availability ──────────────────────────────────────────

  /** Find available tables for a given party size and time. */
  async findAvailableTables(
    date: string,
    time: string,
    partySize: number,
  ): Promise<Table[]> {
    const tables = await this.getTables();
    const suitable = tables.filter((t) => t.capacity >= partySize);
    const settings = await this.getSettings();
    const overlapping = await this.getOverlappingBookings(date, time, settings.seatDurationMinutes);
    const usedTableIds = new Set(overlapping.flatMap((b) => b.tablesUsed));
    return suitable.filter((t) => !usedTableIds.has(t.id));
  }

  /** Pick the smallest available table that fits the party. */
  async findBestTable(
    date: string,
    time: string,
    partySize: number,
  ): Promise<Table | null> {
    const available = await this.findAvailableTables(date, time, partySize);
    available.sort((a, b) => a.capacity - b.capacity);
    return available.length > 0 ? available[0] : null;
  }

  /** Generate available time slots for a date, filtered by existing bookings. */
  async getAvailableSlots(date: string): Promise<string[]> {
    const settings = await this.getSettings();
    const dayOfWeek = new Date(date + "T12:00:00").getDay().toString();
    const hoursStr = settings.openingHours[dayOfWeek];
    if (!hoursStr) return [];

    const parts = hoursStr.split("-");
    if (parts.length !== 2) return [];
    const [openStr, closeStr] = parts as [string, string];
    const openMin = this.timeToMinutes(openStr);
    const closeMin = this.timeToMinutes(closeStr);
    const dur = settings.seatDurationMinutes;

    const allSlots: string[] = [];
    for (let m = openMin; m + dur <= closeMin; m += dur) {
      allSlots.push(this.minutesToTime(m));
    }

    const available: string[] = [];
    for (const slot of allSlots) {
      const overlapping = await this.getOverlappingBookings(date, slot, dur);
      const usedTables = overlapping.flatMap((b) => b.tablesUsed);
      const tables = await this.getTables();
      const freeTables = tables.filter((t) => !usedTables.includes(t.id));
      if (freeTables.length > 0) {
        available.push(slot);
      }
    }

    return available;
  }

  /** Validate party size against restaurant settings. */
  async validatePartySize(size: number): Promise<{ valid: boolean; max: number; min: number }> {
    const settings = await this.getSettings();
    return {
      valid: size >= settings.minPartySize && size <= settings.maxPartySize,
      max: settings.maxPartySize,
      min: settings.minPartySize,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  private async getOverlappingBookings(
    date: string,
    time: string,
    slotMinutes: number,
  ): Promise<Booking[]> {
    const allBookings = await this.getBookingsForDate(date);
    const confirmed = allBookings.filter((b) => b.status === "confirmed");
    const timeMin = this.timeToMinutes(time);
    const timeMax = timeMin + slotMinutes;

    return confirmed.filter((b) => {
      const bMin = this.timeToMinutes(b.time);
      const bMax = bMin + slotMinutes;
      return timeMin < bMax && bMin < timeMax;
    });
  }

  private timeToMinutes(t: string): number {
    const parts = t.split(":").map(Number);
    return parts[0] * 60 + parts[1];
  }

  private minutesToTime(m: number): string {
    const h = Math.floor(m / 60);
    const min = m % 60;
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }

  private async readIndex(key: string): Promise<string[]> {
    const raw = await this.store.read(`idx:${key}`);
    return raw ? (JSON.parse(raw) as string[]) : [];
  }

  private async writeIndex(key: string, codes: string[]): Promise<void> {
    await this.store.write(`idx:${key}`, JSON.stringify(codes));
  }

  private async resolveBookings(codes: string[]): Promise<Booking[]> {
    const results: Booking[] = [];
    const stale: string[] = [];
    for (const code of codes) {
      const b = await this.getBooking(code);
      if (b) {
        results.push(b);
      } else {
        stale.push(code);
      }
    }
    // Clean up stale index entries (booking deleted but index not updated)
    // We don't have access to WHICH index is stale here, so we just skip stale
    return results;
  }
}

// ─── Singleton factory ───────────────────────────────────────────────────

let _store: DomainStore | null = null;

export function getStore(): DomainStore {
  if (!_store) {
    _store = new DomainStore(new MemorySessionStorage<string>());
  }
  return _store;
}

export function resetStore(): void {
  _store = null;
}

/** Create a store with an explicit adapter (injectable for tests). */
export function createStore(adapter: StorageAdapter<string>): DomainStore {
  _store = new DomainStore(adapter);
  return _store;
}
