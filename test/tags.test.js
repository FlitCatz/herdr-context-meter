import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentRowName,
  SPACE_TAG_FONT_SIZE,
  SPACE_TAG_GAP,
  SPACE_TAG_H,
  SPACE_TAG_RADIUS,
  SPACE_TAG_W,
  spaceColor,
  spaceTagText,
} from "../mods/herdr-context-meter/tags.js";
import { shortModel } from "../mods/herdr-context-meter/usage.js";

test("spaceTagText: is the Spaces badge letter (raw first character, uppercased), even when initials collide", () => {
  assert.equal(spaceTagText("mail-server"), "M");
  assert.equal(spaceTagText("herdr-context-meter"), "H");
  assert.equal(spaceTagText("herdr-firstmate"), "H");
  assert.equal(spaceTagText(".dotfiles"), ".");
  assert.equal(spaceTagText("_scratch"), "_");
  assert.equal(spaceTagText("첫번째-작업"), "첫");
  assert.equal(spaceTagText("😀-emoji"), "😀");
});

test("spaceTagText: empty or missing names fall back to ?", () => {
  assert.equal(spaceTagText(""), "?");
  assert.equal(spaceTagText(null), "?");
  assert.equal(spaceTagText(undefined), "?");
});

test("space tag dimensions match the shipped Spaces list badge (18x18, r5, 10.5px, 9px gap)", () => {
  assert.equal(SPACE_TAG_W, 18);
  assert.equal(SPACE_TAG_H, 18);
  assert.equal(SPACE_TAG_RADIUS, 5);
  assert.equal(SPACE_TAG_FONT_SIZE, 10.5);
  assert.equal(SPACE_TAG_GAP, 9);
});

test("spaceColor: matches Spaces MARK palette, supports hex, and falls back to ansi6", () => {
  const theme = /** @type {Record<string, any>} */ ({ ansi6: "#000001", custom: "#123456" });
  const colors = { s1: "ansi3", s2: "#abcdef", s3: "custom" };

  assert.equal(spaceColor("s1", colors, theme), "#e3814f");
  assert.equal(spaceColor("s2", colors, theme), "#abcdef");
  assert.equal(spaceColor("s3", colors, theme), "#123456");
  assert.equal(spaceColor("s4", colors, theme), "#22a99a");
  assert.equal(spaceColor("s4", null, theme), "#22a99a");
});

test("agentRowName: prefers de-duplicated detail, else named/title label, else program name over bare tab numbers", () => {
  const claude = { program: { name: "Claude Code" } };
  const codex = { program: { name: "Codex" } };

  // Named tab or agent title
  assert.equal(agentRowName(claude, "fix-login", "fix-login"), "fix-login");
  // Bare automatic tab number with no collision -> falls back to program name
  assert.equal(agentRowName(claude, null, "2"), "Claude Code");
  // Bare automatic tab number with de-duplication detail -> keeps tab number
  assert.equal(agentRowName(codex, "2", "2"), "2");
  // Missing program name falls back to raw label
  assert.equal(agentRowName({ program: null }, null, "3"), "3");
});

test("shortModel: strips the claude- prefix and date suffix for the second line", () => {
  assert.equal(shortModel("claude-opus-4-6"), "opus-4-6");
  assert.equal(shortModel("claude-sonnet-4-5-20250929"), "sonnet-4-5");
  assert.equal(shortModel("gpt-6.1-sol"), "gpt-6.1-sol");
  assert.equal(shortModel("gpt-5.1-codex-max"), "gpt-5.1-codex-max");
  assert.equal(shortModel("gemini-4-hydrogen-medium"), "Gemini 4 Hydrogen");
  assert.equal(shortModel("Gemini 4 Hydrogen (Medium)"), "Gemini 4 Hydrogen");
  assert.equal(shortModel("gemini-4-argon-high"), "Gemini 4 Argon");
  assert.equal(shortModel("gemini-3.8-flash-low"), "Gemini 3.8 Flash");
  assert.equal(shortModel("claude-opus-5-5-high"), "opus-5-5");
  assert.equal(shortModel(null), "");
});
