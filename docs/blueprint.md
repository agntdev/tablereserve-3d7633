# TableReserve Bot — Bot specification

**Archetype:** booking

**Voice:** professional and warm — write every user-facing message, button label, error, and empty state in this voice.

A restaurant booking bot that guides guests through date/time/party size selection while showing only available slots based on restaurant settings and existing bookings. Includes admin views for owners to manage reservations, track capacity, and mark no-shows. Features automated reminders and inline rescheduling/cancellation for guests.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Restaurant owners and staff
- Restaurant guests seeking reservations

## Success criteria

- Guests can complete full booking flow with valid slots
- Owners receive real-time booking updates and daily capacity summaries
- System prevents double-bookings and enforces seating rules

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open main menu with booking CTA
- **Book a table** (button, actor: user, callback: booking:start) — Initiates guided reservation flow
  - inputs: date, time, party size
  - outputs: booking confirmation code, reservation details
- **/admin** (command, actor: owner, command: /admin) — Opens owner dashboard with booking management

## Flows

### Guest booking
_Trigger:_ /start or Book a table button

1. Date selection with validation
2. Time slot filtering by availability
3. Party size validation
4. Booking confirmation with code
5. Reminder scheduling

_Data touched:_ restaurant_settings, tables, bookings

### Owner management
_Trigger:_ /admin or dashboard button

1. Display daily capacity summary
2. List upcoming bookings
3. Mark no-shows/cancellations

_Data touched:_ restaurant_settings, bookings

### Reschedule flow
_Trigger:_ Reschedule button in confirmation

1. Re-initiate booking flow with existing data
2. Apply new slot constraints
3. Update booking record

_Data touched:_ bookings

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **restaurant_settings** _(retention: persistent)_ — Restaurant configuration including opening hours, seat duration, booking window
  - fields: opening_hours, seat_duration, advance_window, reminder_lead_time
- **tables** _(retention: persistent)_ — List of tables with capacities and identifiers
  - fields: id, capacity, name
- **bookings** _(retention: persistent)_ — Reservation records with status tracking
  - fields: code, guest_name, phone, party_size, datetime, status, tables_used
- **owner_accounts** _(retention: persistent)_ — Telegram IDs with admin access
  - fields: telegram_id, permissions

## Integrations

- **Telegram** (required) — Bot API messaging
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Configure restaurant settings
- View/edit bookings
- Mark no-shows
- Set notification preferences

## Notifications

- Guest reminders before reservation
- Owner alerts on new bookings
- Daily capacity summaries for owners

## Permissions & privacy

- Guest data accessible only to owner and respective guest
- Bookings stored with configurable retention
- No third-party data sharing

## Edge cases

- Invalid date/time input handling
- Party size exceeding capacity
- Conflicting bookings during rescheduling
- No available slots for requested parameters

## Required tests

- End-to-end booking flow with slot validation
- Owner dashboard data accuracy
- Reminder message delivery timing
- No-show marking functionality

## Assumptions

- Restaurant uses 90-minute seat duration by default
- Guest phone/name is optional but recommended
- Single owner account initially configured
