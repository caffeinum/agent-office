// What an agent's desk monitor shows, as a list of paint ops (rects and monospace text) on a small pixel screen:
// the activity as a terminal in its client's colours while working, an amber prompt while waiting, a dim screensaver
// while idle, dark while away. Pure, so the browser (canvas) and the Apple TV (CoreGraphics) paint the same picture.

import { hashStr } from "./model.js";

export const SCREEN_W = 256;
export const SCREEN_H = 150;
/** Monospace advance as a share of the font size (both painters use a monospace font). */
const CHAR = 0.6;

/** Terminal looks per client (matched on the client name); `null` accent means the agent's own colour. */
const STYLES = [
  { match: /claude/i, bg: "#1f1b16", bar: "#2b241d", fg: "#eee6da", accent: "#d97757", dim: "#8a7d6c", prompt: "✻" },
  { match: /codex|openai/i, bg: "#0b0f0c", bar: "#141c16", fg: "#d7f5df", accent: "#4ade80", dim: "#5e7c66", prompt: "›" },
  { match: /cursor/i, bg: "#1e1e24", bar: "#26262e", fg: "#e4e4ee", accent: "#8b9cff", dim: "#6d6d80", prompt: "⌘", tree: true },
  { match: /gemini/i, bg: "#0f1420", bar: "#172033", fg: "#dbe6ff", accent: "#8ab4f8", dim: "#5f6f8f", prompt: "✦" },
  { match: /paw/i, bg: "#17151f", bar: "#211d2c", fg: "#ece6ff", accent: "#c084fc", dim: "#77708c", prompt: "🐾" },
];
const DEFAULT_STYLE = { bg: "#1b2230", bar: "#232c3d", fg: "#e6ebf3", accent: null, dim: "#6c7891", prompt: "$" };

export function screenStyle(client, hueCss) {
  const s = STYLES.find((x) => x.match.test(client ?? "")) ?? DEFAULT_STYLE;
  return { ...s, accent: s.accent ?? hueCss };
}

/** Greedy word wrap to `cols` characters, at most `max` lines (the last one ellipsised if cut). */
function wrap(text, cols, max) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= cols) { cur = next; continue; }
    if (cur) lines.push(cur);
    cur = w.length > cols ? w.slice(0, cols - 1) + "…" : w;
    if (lines.length === max) break;
  }
  if (cur && lines.length < max) lines.push(cur);
  if (lines.length === max && words.join(" ").length > lines.join(" ").length) lines[max - 1] = lines[max - 1].slice(0, cols - 1) + "…";
  return lines;
}

/**
 * The monitor of `agent` ({id, status, activity, client}) with its hue colour `hueCss`:
 * {w, h, ops: [{op: "rect", x, y, w, h, color} | {op: "text", x, y, size, color, text, bold}]}. Text y is the baseline.
 */
export function screenSpec(agent, hueCss) {
  const W = SCREEN_W, H = SCREEN_H, ops = [];
  const rect = (x, y, w, h, color) => ops.push({ op: "rect", x, y, w, h, color });
  const text = (x, y, size, color, t, bold = false) => ops.push({ op: "text", x, y, size, color, text: t, bold });
  const st = screenStyle(agent.client, hueCss);
  const seed = hashStr(agent.id);

  if (agent.status === "away") {
    rect(0, 0, W, H, "#07080a");
    return { w: W, h: H, ops };
  }
  if (agent.status === "idle") {
    // screensaver: the client's prompt mark drifting on a dark screen, placed by the agent's id
    rect(0, 0, W, H, "#0d0f14");
    text(30 + (seed % 150), 50 + ((seed >> 8) % 70), 26, st.dim, st.prompt);
    return { w: W, h: H, ops };
  }

  rect(0, 0, W, H, st.bg);
  // title bar: three dots and the client name
  rect(0, 0, W, 20, st.bar);
  for (const [i, c] of ["#ff5f57", "#febc2e", "#28c840"].entries()) rect(8 + i * 12, 7, 7, 7, c);
  text(50, 15, 12, st.dim, agent.client ?? "agent");
  let x0 = 10;
  if (st.tree) {
    // an editor's file tree down the left
    rect(0, 18, 46, H - 18, st.bar);
    for (let i = 0; i < 7; i++) rect(8 + (i % 3 ? 6 : 0), 30 + i * 15, 20 + ((seed >> i) % 14), 5, st.dim);
    x0 = 54;
  }
  const size = 19, cols = Math.floor((W - x0 - 8) / (size * CHAR));
  const waiting = agent.status === "waiting";
  const what = (agent.activity ?? "").trim() || (waiting ? "needs input" : "working");
  const lines = wrap(what, cols - 2, 3);
  let y = 44;
  for (const [i, l] of lines.entries()) {
    if (i === 0) text(x0, y, size, waiting ? "#f2b33d" : st.accent, waiting ? "?" : st.prompt, true);
    text(x0 + size * CHAR * 2, y, size, st.fg, l, i === 0);
    y += size + 4;
  }
  if (waiting) {
    rect(x0, y + 2, Math.min(W - x0 - 10, 180), 26, "#f2b33d");
    text(x0 + 8, y + 21, 16, "#3a2a10", "waiting for you", true);
    return { w: W, h: H, ops };
  }
  // some output under the command: dim bars of varying length, and a cursor block at the end
  y += 2;
  for (let i = 0; y < H - 14 && i < 6; i++, y += 11) rect(x0, y, 30 + ((seed >> (i * 3)) % (W - x0 - 60)), 5, i % 3 === 2 ? st.accent : st.dim);
  rect(x0, Math.min(y, H - 12), 7, 9, st.accent);
  return { w: W, h: H, ops };
}

/** What a screen depends on, to redraw only when it changes. */
export const screenKey = (agent, hueCss) => `${agent.status}|${agent.activity ?? ""}|${agent.client ?? ""}|${hueCss}`;
