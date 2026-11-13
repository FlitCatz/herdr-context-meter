import { test } from "node:test";
import assert from "node:assert/strict";
import { agentRowName, SPACE_TAG_W, spaceColor, spaceTagText, spaceTags } from "../mods/herdr-context-meter/tags.js";
import { shortModel } from "../mods/herdr-context-meter/usage.js";

test("spaceTags: unique initials use one letter; collisions use two letters deterministically", () => {
  const tags = spaceTags([
    { space: "s1", space_name: "proj-firstmate" },
    { space: "s2", space_name: "herdr-context-meter" },
    { space: "s3", space_name: "herdr-firstmate" },
    { space: "s4", space_name: "tjerps" },
    { space: "s5", space_name: "Tjerps-tutorial" },
    { space: "s6", space_name: "mail-server" },
  ]);

  assert.equal(tags.get("s1"), "P");
  assert.equal(tags.get("s2"), "HC");
  assert.equal(tags.get("s3"), "HF");
  assert.equal(tags.get("s4"), "TJ");
  assert.equal(tags.get("s5"), "TT");
  assert.equal(tags.get("s6"), "M");
});

test("spaceTags: two-letter tags that still collide get a third letter", () => {
  const tags = spaceTags([
    { space: "s1", space_name: "herdr-tab-namer" },
    { space: "s2", space_name: "herdr-token-viewer" },
    { space: "s3", space_name: "herdr-context-meter" },
    { space: "s4", space_name: "herdr-tab" },
  ]);

  assert.equal(tags.get("s1"), "HTN");
  assert.equal(tags.get("s2"), "HTV");
  assert.equal(tags.get("s3"), "HC");
  assert.equal(tags.get("s4"), "HTA");
});

test("spaceTags: without a collision the tag is the Spaces badge letter (raw first character)", () => {
  const tags = spaceTags([
    { space: "s1", space_name: ".dotfiles" },
    { space: "s2", space_name: "_scratch" },
    { space: "s3", space_name: "mail-server" },
  ]);

  assert.equal(tags.get("s1"), ".");
  assert.equal(tags.get("s2"), "_");
  assert.equal(tags.get("s3"), "M");
});

test("spaceTags: multiple agents in the same space do not collide with themselves", () => {
  const tags = spaceTags([
    { space: "s1", space_name: "herdr-context-meter" },
    { space: "s1", space_name: "herdr-context-meter" },
    { space: "s2", space_name: "policy-kernel" },
  ]);

  assert.equal(tags.get("s1"), "H");
  assert.equal(tags.get("s2"), "P");
});

test("spaceTagText: handles empty, symbol, single-char, and Unicode names", () => {
  assert.equal(spaceTagText("", 1), "?");
  assert.equal(spaceTagText(null, 2), "?");
  assert.equal(spaceTagText("~", 2), "~");
  assert.equal(spaceTagText("a", 2), "A");
  assert.equal(spaceTagText("첫째", 2), "첫째");
  assert.equal(spaceTagText("첫번째-작업", 2), "첫작");
});

test("SPACE_TAG_W: fixed badge column fits a 3-letter tag (8px padding + 8px per letter)", () => {
  assert.equal(SPACE_TAG_W, 32);
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
  assert.equal(shortModel("gemini-4-hydrogen-medium"), "Gemini 4 Hydrogen");
  assert.equal(shortModel("Gemini 4 Hydrogen (Medium)"), "Gemini 4 Hydrogen");
  assert.equal(shortModel("gemini-4-argon-high"), "Gemini 4 Argon");
  assert.equal(shortModel("gemini-3.8-flash-low"), "Gemini 3.8 Flash");
  assert.equal(shortModel("claude-opus-5-5-high"), "opus-5-5");
  assert.equal(shortModel(null), "");
});
