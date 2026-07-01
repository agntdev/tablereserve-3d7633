// Domain data store — persistent storage for restaurant_settings, tables,
// bookings, and owner_accounts. Uses the toolkit's persistent store
// (Redis-backed) in production, in-memory in dev/tests.
//
// RULES:
//  - Never enumerate keyspace (no KEYS/SCAN/readAll). Use explicit INDEX
//    records (key → id[]) to read collections.
//  - All methods are async so they work identically with Redis or memory.

import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RestaurantSettings {
  opening_hours: Record<string, { open: string; close: string }>;
  seat_duration: number; // minutes (default 90)
  advance_window: number; // days (default 30)
  reminder_lead_time: number; // minutes before (default 60)
}

export interface Table {
  id: string;
  capacity: number;
  name: string;
}

export interface Booking {
  code: string;
  guest_name: string;
  phone: string;
  party_size: number;
  datetime: string; // "2026-07-15T19:00"
  status: "confirmed" | "cancelled" | "no_show" | "completed";
  tables_used: string[];
  /** Telegram user id who made the booking */
  user_id?: number;
  /** Chat id for sending reminders */
  chat_id?: number;
  /** Timestamp (ISO string) when the reminder was last sent; undefined = never */
  reminded_at?: string;
}

export interface OwnerAccount {
  telegram_id: number;
  permissions: string[];
}

// ---------------------------------------------------------------------------
// KV interface (duck-typed so either Map or Redis can power it)
// ---------------------------------------------------------------------------

export interface KVStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory KV (dev / tests)
// ---------------------------------------------------------------------------

export class MemoryKV implements KVStore {
  private m = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.m.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.m.set(key, value);
  }
  async del(key: string): Promise<void> {
    this.m.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Redis KV (production)
// ---------------------------------------------------------------------------

/** Lazy-loaded ioredis wrapper. Only imported when REDIS_URL is set. */
export function createRedisKV(url: string): KVStore {
  const require = createRequire(import.meta.url);
  const ioredis: any = require("ioredis");
  const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;
  const client = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
  return {
    async get(key: string): Promise<string | null> {
      const v = await client.get(key);
      return v ?? null;
    },
    async set(key: string, value: string): Promise<void> {
      await client.set(key, value);
    },
    async del(key: string): Promise<void> {
      await client.del(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Index helpers — add/remove ids from a JSON-array index key
// ---------------------------------------------------------------------------

async function indexAdd(kv: KVStore, key: string, id: string): Promise<void> {
  const raw = await kv.get(key);
  const arr: string[] = raw ? JSON.parse(raw) : [];
  if (!arr.includes(id)) {
    arr.push(id);
    await kv.set(key, JSON.stringify(arr));
  }
}

async function indexRemove(kv: KVStore, key: string, id: string): Promise<void> {
  const raw = await kv.get(key);
  if (!raw) return;
  const arr: string[] = JSON.parse(raw).filter((x: string) => x !== id);
  if (arr.length > 0) {
    await kv.set(key, JSON.stringify(arr));
  } else {
    await kv.del(key);
  }
}

async function indexList(kv: KVStore, key: string): Promise<string[]> {
  const raw = await kv.get(key);
  return raw ? JSON.parse(raw) : [];
}

// ---------------------------------------------------------------------------
// PersistentStore — typed CRUD + index management
// ---------------------------------------------------------------------------

export class PersistentStore {
  constructor(private kv: KVStore) {}

  // --- Restaurant settings ---

  async getSettings(): Promise<RestaurantSettings | null> {
    const raw = await this.kv.get("settings");
    return raw ? (JSON.parse(raw) as RestaurantSettings) : null;
  }

  async saveSettings(s: RestaurantSettings): Promise<void> {
    await this.kv.set("settings", JSON.stringify(s));
  }

  async getDefaultSettings(): Promise<RestaurantSettings> {
    const existing = await this.getSettings();
    if (existing) return existing;
    const defaults: RestaurantSettings = {
      opening_hours: {
        mon: { open: "09:00", close: "22:00" },
        tue: { open: "09:00", close: "22:00" },
        wed: { open: "09:00", close: "22:00" },
        thu: { open: "09:00", close: "22:00" },
        fri: { open: "09:00", close: "23:00" },
        sat: { open: "10:00", close: "23:00" },
        sun: { open: "10:00", close: "21:00" },
      },
      seat_duration: 90,
      advance_window: 30,
      reminder_lead_time: 60,
    };
    await this.saveSettings(defaults);
    return defaults;
  }

  // --- Tables ---

  async saveTable(t: Table): Promise<void> {
    await this.kv.set(`table:${t.id}`, JSON.stringify(t));
    await indexAdd(this.kv, "idx:table_ids", t.id);
  }

  async getTable(id: string): Promise<Table | null> {
    const raw = await this.kv.get(`table:${id}`);
    return raw ? (JSON.parse(raw) as Table) : null;
  }

  async listTables(): Promise<Table[]> {
    const ids = await indexList(this.kv, "idx:table_ids");
    const results = await Promise.all(ids.map((id) => this.getTable(id)));
    return results.filter((t): t is Table => t !== null);
  }

  async deleteTable(id: string): Promise<void> {
    await this.kv.del(`table:${id}`);
    await indexRemove(this.kv, "idx:table_ids", id);
  }

  // --- Bookings ---

  async saveBooking(b: Booking): Promise<void> {
    await this.kv.set(`booking:${b.code}`, JSON.stringify(b));
    // Index by date (YYYY-MM-DD)
    const date = b.datetime.substring(0, 10);
    await indexAdd(this.kv, `idx:date_bookings:${date}`, b.code);
    // Index by user
    if (b.user_id != null) {
      await indexAdd(
        this.kv,
        `idx:user_bookings:${b.user_id}`,
        b.code,
      );
    }
  }

  async getBooking(code: string): Promise<Booking | null> {
    const raw = await this.kv.get(`booking:${code}`);
    return raw ? (JSON.parse(raw) as Booking) : null;
  }

  async listBookingsByDate(date: string): Promise<Booking[]> {
    const codes = await indexList(this.kv, `idx:date_bookings:${date}`);
    const results = await Promise.all(codes.map((c) => this.getBooking(c)));
    return results.filter((b): b is Booking => b !== null);
  }

  async listBookingsByUser(userId: number): Promise<Booking[]> {
    const codes = await indexList(this.kv, `idx:user_bookings:${userId}`);
    const results = await Promise.all(codes.map((c) => this.getBooking(c)));
    return results.filter((b): b is Booking => b !== null);
  }

  async listAllUpcomingBookings(): Promise<Booking[]> {
    // Get all date indices (we can't scan, but we know the pattern)
    // We need an index of all dates that have bookings
    // Use a master index: idx:booking_dates → ["2026-07-15", ...]
    const dates = await indexList(this.kv, "idx:booking_dates");
    const all: Booking[] = [];
    for (const date of dates) {
      const codes = await indexList(this.kv, `idx:date_bookings:${date}`);
      const bookings = (
        await Promise.all(codes.map((c) => this.getBooking(c)))
      ).filter((b): b is Booking => b !== null);
      all.push(...bookings);
    }
    return all;
  }

  private async ensureDateIndex(date: string): Promise<void> {
    // Called when a booking is created — ensures the date is in the master index
    const dates = await indexList(this.kv, "idx:booking_dates");
    if (!dates.includes(date)) {
      dates.push(date);
      await this.kv.set("idx:booking_dates", JSON.stringify(dates));
    }
  }

  async saveBookingWithDateIndex(b: Booking): Promise<void> {
    await this.saveBooking(b);
    await this.ensureDateIndex(b.datetime.substring(0, 10));
  }

  async updateBookingStatus(
    code: string,
    status: Booking["status"],
  ): Promise<Booking | null> {
    const b = await this.getBooking(code);
    if (!b) return null;
    b.status = status;
    await this.saveBooking(b);
    return b;
  }

  // --- Owner accounts ---

  async saveOwner(owner: OwnerAccount): Promise<void> {
    await this.kv.set(`owner:${owner.telegram_id}`, JSON.stringify(owner));
    await indexAdd(this.kv, "idx:owner_ids", String(owner.telegram_id));
  }

  async getOwner(telegramId: number): Promise<OwnerAccount | null> {
    const raw = await this.kv.get(`owner:${telegramId}`);
    return raw ? (JSON.parse(raw) as OwnerAccount) : null;
  }

  async isOwner(telegramId: number): Promise<boolean> {
    return (await this.getOwner(telegramId)) !== null;
  }

  async listOwners(): Promise<OwnerAccount[]> {
    const ids = await indexList(this.kv, "idx:owner_ids");
    const results = await Promise.all(
      ids.map((id) => this.getOwner(Number(id))),
    );
    return results.filter((o): o is OwnerAccount => o !== null);
  }

  // --- Slot availability ---

  /** Find available slots for a given date and party size. */
  async findAvailableSlots(
    date: string,
    partySize: number,
  ): Promise<string[]> {
    const settings = await this.getDefaultSettings();
    const tables = await this.listTables();
    const dayOfWeek = getDayOfWeek(date);

    const dayHours = settings.opening_hours[dayOfWeek];
    if (!dayHours) return []; // Restaurant closed that day

    // Filter tables that can fit the party
    const suitableTables = tables.filter((t) => t.capacity >= partySize);
    if (suitableTables.length === 0) return [];

    // Get existing bookings for the date
    const existing = await this.listBookingsByDate(date);
    const confirmed = existing.filter(
      (b) => b.status === "confirmed" || b.status === "completed",
    );

    // Build occupancy map: time slot → occupied table ids
    const occupiedAt = new Map<string, Set<string>>();
    for (const b of confirmed) {
      const dt = new Date(b.datetime);
      const rawStartM = dt.getHours() * 60 + dt.getMinutes();
      // Round DOWN to the nearest 30-min boundary so a booking at 19:15
      // marks 19:00 as occupied — preventing a candidate at 19:00 from
      // appearing available when the table is actually occupied from 19:15.
      const startM = Math.floor(rawStartM / 30) * 30;
      const endM = startM + settings.seat_duration;
      for (const tid of b.tables_used) {
        for (let m = startM; m < endM; m += 30) {
          const h = Math.floor(m / 60);
          const min = m % 60;
          const label = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
          if (!occupiedAt.has(label)) occupiedAt.set(label, new Set());
          occupiedAt.get(label)!.add(tid);
        }
      }
    }

    // Generate candidate slots
    const [openH, openM] = dayHours.open.split(":").map(Number);
    const [closeH, closeM] = dayHours.close.split(":").map(Number);
    const openMinutes = openH * 60 + openM;
    const closeMinutes = closeH * 60 + closeM;

    const slots: string[] = [];
    for (let m = openMinutes; m + settings.seat_duration <= closeMinutes; m += 30) {
      const h = Math.floor(m / 60);
      const min = m % 60;
      const label = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;

      const occAtTime = occupiedAt.get(label) ?? new Set();
      // A slot is available if at least one suitable table is free
      const free = suitableTables.some((t) => !occAtTime.has(t.id));
      if (free) slots.push(label);
    }

    return slots;
  }

  /** Generate a unique booking code. */
  async generateBookingCode(): Promise<string> {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let attempt = 0; attempt < 20; attempt++) {
      let code = "";
      for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
      }
      if (!(await this.getBooking(code))) return code;
    }
    // Fallback: very unlikely
    return `BK-${Date.now().toString(36).toUpperCase()}`;
  }

  // --- Owner notification preferences ---

  async getOwnerPrefs(telegramId: number): Promise<OwnerNotificationPrefs> {
    const raw = await this.kv.get(`owner_prefs:${telegramId}`);
    if (raw) return JSON.parse(raw) as OwnerNotificationPrefs;
    return { new_booking_alerts: true, daily_summary: true };
  }

  async saveOwnerPrefs(telegramId: number, prefs: OwnerNotificationPrefs): Promise<void> {
    await this.kv.set(`owner_prefs:${telegramId}`, JSON.stringify(prefs));
  }
}

/** Owner notification preferences. */
export interface OwnerNotificationPrefs {
  new_booking_alerts: boolean;
  daily_summary: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY_NAMES: Record<string, string> = {
  "0": "sun",
  "1": "mon",
  "2": "tue",
  "3": "wed",
  "4": "thu",
  "5": "fri",
  "6": "sat",
};

function getDayOfWeek(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return DAY_NAMES[String(d.getDay())] ?? "mon";
}

// ---------------------------------------------------------------------------
// Factory: auto-select Redis or in-memory
// ---------------------------------------------------------------------------

let _store: PersistentStore | null = null;
let _seeded = false;

export async function getStore(): Promise<PersistentStore> {
  if (_store) return _store;
  const url = process.env.REDIS_URL;
  const kv: KVStore = url ? createRedisKV(url) : new MemoryKV();
  _store = new PersistentStore(kv);
  if (!_seeded) {
    _seeded = true;
    await seedDefaults(_store);
  }
  return _store;
}

async function seedDefaults(store: PersistentStore): Promise<void> {
  // Seed default owner if none exists. In production, use OWNER_TELEGRAM_ID env
  // var (the deployer sets this to the restaurant owner's Telegram user id).
  // In test/dev, telegram_id=1 is the test harness user.
  const owners = await store.listOwners();
  if (owners.length === 0) {
    const ownerTelegramId = process.env.OWNER_TELEGRAM_ID
      ? parseInt(process.env.OWNER_TELEGRAM_ID, 10)
      : 1;
    if (!isNaN(ownerTelegramId)) {
      await store.saveOwner({ telegram_id: ownerTelegramId, permissions: ["admin"] });
    }
  }

  // Seed default tables if none exist
  const tables = await store.listTables();
  if (tables.length === 0) {
    await store.saveTable({ id: "T1", capacity: 2, name: "Table 1" });
    await store.saveTable({ id: "T2", capacity: 4, name: "Table 2" });
    await store.saveTable({ id: "T3", capacity: 6, name: "Table 3" });
    await store.saveTable({ id: "T4", capacity: 8, name: "Table 4" });
  }
}

/** Test hook: replace the store. Pass null to reset. */
export function setStore(s: PersistentStore | null): void {
  _store = s;
}
