// One read round at a time, and a round that hangs never blocks the next one.
//
// A started round gets a ticket. If it has not finished within `limitMs`, the next tick starts
// a new round with a new ticket, and the old round's late result is refused by `finish`.
// This is the lesson of the Board's #11: one stuck read must not freeze later updates.

export class Rounds {
  /** @param {number} limitMs */
  constructor(limitMs) {
    this.limitMs = limitMs;
    this.ticket = 0;
    this.running = false;
    this.startedAt = 0;
  }

  /**
   * A ticket for a new round, or null while the running one is still within its limit.
   * @param {number} now
   * @returns {number | null}
   */
  begin(now) {
    if (this.running && now - this.startedAt < this.limitMs) return null;
    this.running = true;
    this.startedAt = now;
    return ++this.ticket;
  }

  /**
   * Whether this round's result may be used: false once a newer round has begun.
   * @param {number} ticket
   */
  finish(ticket) {
    if (ticket !== this.ticket) return false;
    this.running = false;
    return true;
  }
}
