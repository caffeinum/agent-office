// What the office sounds like, as data: which frame makes which sound. Pure, so the browser and the Apple TV
// (through its JavaScriptCore bridge) hear the same office; each platform only synthesizes the cues.

import { hashStr } from "./model.js";

/** Minimum gap between two cues of the same sound (ms), and between two babbles of one agent. */
export const SOUND_GAP_MS = 300;
export const BABBLE_GAP_MS = 4000;
export const BABBLE_MAX_SYLLABLES = 8;

/**
 * The cues one frame produces, given the state before and after it:
 * join / leave {agent}, place / break {x, z}, ding {agent}, babble {agent, voice, syllables, question}.
 * A snapshot is the whole office arriving at once, so it makes no sound.
 */
export function soundCues(prev, frame, next) {
  if (!prev || frame.type === "snapshot") return [];
  switch (frame.type) {
    case "agent": {
      const a = frame.agent;
      const before = prev.agents.find((x) => x.id === a.id);
      if (!before) return [{ sound: "join", agent: a.id }];
      const cues = [];
      if (a.status === "waiting" && before.status !== "waiting") cues.push({ sound: "ding", agent: a.id });
      const said = a.says?.text;
      if (said && (said !== before.says?.text || a.says.ts !== before.says?.ts)) {
        cues.push({
          sound: "babble",
          agent: a.id,
          voice: hashStr(a.id) % 1000,
          syllables: Math.max(1, Math.min(BABBLE_MAX_SYLLABLES, Math.ceil(said.length / 2))),
          question: said.trim().endsWith("?"),
        });
      }
      return cues;
    }
    case "agent-left":
      return prev.agents.some((x) => x.id === frame.id) ? [{ sound: "leave", agent: frame.id }] : [];
    case "item": {
      const it = frame.item;
      const before = prev.items.find((x) => x.id === it.id);
      if (before && before.x === it.x && before.z === it.z && before.rot === it.rot) return [];
      return [{ sound: "place", x: it.x, z: it.z }];
    }
    case "item-removed": {
      const it = prev.items.find((x) => x.id === frame.id);
      return it ? [{ sound: "break", x: it.x, z: it.z }] : [];
    }
    default:
      return [];
  }
}

/** Rate limits: one cue per sound type every SOUND_GAP_MS, one babble per agent every BABBLE_GAP_MS. */
export function cueGate() {
  const lastBySound = new Map(), lastBabble = new Map();
  return (cue, now) => {
    if (cue.sound === "babble") {
      if (now - (lastBabble.get(cue.agent) ?? -Infinity) < BABBLE_GAP_MS) return false;
      lastBabble.set(cue.agent, now);
      return true;
    }
    if (now - (lastBySound.get(cue.sound) ?? -Infinity) < SOUND_GAP_MS) return false;
    lastBySound.set(cue.sound, now);
    return true;
  };
}
