// Addressing the assistant in typed text (notes #4).
//
// This matcher is a gate bypass: a match means the caption skips the trigger
// gate, the cooldown and the rate cap, and the agent runs a turn no matter what
// the kelabo is doing. So both directions are worth asserting — a miss loses a
// question a participant asked in so many words, and a false positive is an
// unstoppable lookup nobody wanted.
import assert from "node:assert/strict";
import { addressesAssistant, stripAddress } from "../src/mention.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

// --- addressed --------------------------------------------------------------

test("@mention anywhere in the line is an address", () => {
  assert.equal(addressesAssistant("@kelabo what is the retry policy?"), true);
  assert.equal(addressesAssistant("could someone ask @kelabo about this"), true);
  assert.equal(addressesAssistant("@Kelabo WHAT"), true);
});

test("the bare name in vocative position is an address", () => {
  assert.equal(addressesAssistant("kelabo, what is the retry policy?"), true);
  assert.equal(addressesAssistant("Kelabo: check the changelog"), true);
  assert.equal(addressesAssistant("  kelabo - look this up"), true);
});

// --- not addressed ----------------------------------------------------------

test("the bare name mid-sentence is a remark, not an address", () => {
  // Nobody is being asked anything here, and firing a lookup on it would make
  // the assistant impossible to talk *about*.
  assert.equal(addressesAssistant("I asked kelabo yesterday and it was wrong"), false);
  assert.equal(addressesAssistant("kelabo is the name of the product"), false);
});

test("a vocative with nothing after it is not a question", () => {
  assert.equal(addressesAssistant("kelabo,"), false);
  assert.equal(addressesAssistant("kelabo, "), false);
});

test("the name inside a longer word is not a mention", () => {
  assert.equal(addressesAssistant("@kelaboard is a different thing"), false);
  assert.equal(addressesAssistant("email me at alex@kelabo.example"), false);
});

test("empty and junk input never address anyone", () => {
  assert.equal(addressesAssistant(""), false);
  assert.equal(addressesAssistant(null), false);
  assert.equal(addressesAssistant(undefined), false);
});

// --- the query the agent actually receives ----------------------------------

test("stripping removes the address and keeps the question", () => {
  assert.equal(stripAddress("@kelabo what is the retry policy?"), "what is the retry policy?");
  assert.equal(stripAddress("kelabo, what is the retry policy?"), "what is the retry policy?");
  assert.equal(stripAddress("Kelabo: check the changelog"), "check the changelog");
});

test("a mid-sentence mention keeps its surrounding words", () => {
  assert.equal(stripAddress("could someone ask @kelabo about this"), "could someone ask about this");
});

test("stripping never yields an empty query", () => {
  // An empty query downstream titles a board card with nothing at all, which is
  // worse than echoing back what little was typed.
  assert.equal(stripAddress("@kelabo"), "@kelabo");
  assert.equal(stripAddress("  @kelabo  "), "@kelabo");
});

console.log(`contracts/mention: ${passed} passed`);
