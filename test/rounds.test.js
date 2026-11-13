import { test } from "node:test";
import assert from "node:assert/strict";
import { Rounds } from "../mods/herdr-context-meter/rounds.js";

test("a new round waits for the running one while it is within its limit", () => {
  const rounds = new Rounds(20000);
  assert.equal(rounds.begin(0), 1);
  assert.equal(rounds.begin(5000), null);
  assert.equal(rounds.begin(19999), null);
  assert.equal(rounds.finish(1), true);
  assert.equal(rounds.begin(20000), 2);
});

test("a round past its limit is given up on: the next one starts and the late result is refused", () => {
  const rounds = new Rounds(20000);
  const stuck = rounds.begin(0);
  assert.equal(rounds.begin(20000), 2);
  assert.equal(rounds.finish(stuck), false);
  assert.equal(rounds.finish(2), true);
});

test("a hung read never freezes later updates (the loop as main.js runs it)", async () => {
  const rounds = new Rounds(20000);
  const shown = [];
  /** @type {(v: string) => void} */
  let releaseHung;
  let reads = 0;
  // The first read never returns by itself; every later one answers at once.
  const read = () => (++reads === 1 ? new Promise((resolve) => { releaseHung = resolve; }) : Promise.resolve(`read ${reads}`));
  const tick = async (/** @type {number} */ now) => {
    const ticket = rounds.begin(now);
    if (ticket === null) return;
    const result = await read();
    if (rounds.finish(ticket)) shown.push(result);
  };
  const first = tick(0);           // hangs
  await tick(5000);                // still within the limit: no new round
  await tick(10000);
  assert.equal(reads, 1);
  await tick(20000);               // over the limit: a new round runs and shows
  assert.deepEqual(shown, ["read 2"]);
  releaseHung("late");             // the hung read finally answers: refused
  await first;
  assert.deepEqual(shown, ["read 2"]);
  await tick(25000);
  assert.deepEqual(shown, ["read 2", "read 3"]);
});
