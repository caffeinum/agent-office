// The office's sounds, synthesized in WebAudio from sound-plan.js cues: chunky, short, blocky foley in a voxel-game
// spirit (thunks, crunches, pops, blip-babble), all generated here, no recorded assets. Off until the viewer turns
// it on (browsers only allow audio after a click), and the choice is remembered.

import { cueGate } from "./sound-plan.js";

const MAX_VOICES = 6;
const STORE = "office.sound";

export function createSound() {
  let ctx = null, master = null, noise = null;
  let on = false;
  let voices = 0;
  const gate = cueGate();
  try { on = localStorage.getItem(STORE) === "on"; } catch { /* storage blocked: stays off */ }

  function ensure() {
    if (ctx) return;
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.32;
    master.connect(ctx.destination);
    // one second of white noise, reused by every crunch and thunk
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  /** A voice: a panned gain that frees its slot when its sources end. */
  function voice(pan, gain, dur) {
    const g = ctx.createGain();
    g.gain.value = gain;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p).connect(master);
    voices++;
    setTimeout(() => { voices--; g.disconnect(); }, (dur + 0.1) * 1000);
    return g;
  }

  const env = (param, t, peak, attack, decay) => {
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(peak, t + attack);
    param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  };

  function tone(out, t, type, f0, f1, dur, peak = 1) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    env(g.gain, t, peak, 0.005, dur);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function burst(out, t, freq, q, dur, peak = 1) {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noise;
    s.playbackRate.value = 0.6 + Math.random() * 0.8;
    f.type = "bandpass";
    f.frequency.value = freq;
    f.Q.value = q;
    env(g.gain, t, peak, 0.003, dur);
    s.connect(f).connect(g).connect(out);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.05);
  }

  const RECIPES = {
    // a block set down: a woody thunk (low thump + short knock)
    place(out, t) {
      tone(out, t, "sine", 150, 70, 0.09, 0.9);
      burst(out, t, 900 + Math.random() * 300, 3, 0.06, 0.7);
    },
    // a block broken: a few gravelly crunches tumbling down in pitch
    break(out, t) {
      for (let i = 0; i < 4; i++) burst(out, t + i * 0.045, 1400 - i * 220 + Math.random() * 150, 2.2, 0.05, 0.8 - i * 0.15);
    },
    // someone walks in: a bright pop that rises
    join(out, t) {
      tone(out, t, "square", 330, 880, 0.11, 0.35);
      burst(out, t, 2400, 5, 0.02, 0.4);
    },
    // someone leaves: a door clack and a pop that falls
    leave(out, t) {
      burst(out, t, 700, 4, 0.04, 0.6);
      tone(out, t + 0.05, "square", 700, 260, 0.13, 0.3);
    },
    // waiting on a human: two soft chime notes, once
    ding(out, t) {
      tone(out, t, "triangle", 1318.5, 1318.5, 0.18, 0.5);
      tone(out, t + 0.16, "triangle", 1046.5, 1046.5, 0.26, 0.5);
    },
    // talking: a quick run of blips at the agent's own pitch, falling at the end (rising for a question)
    babble(out, t, cue) {
      const base = 200 + (cue.voice % 220);
      for (let i = 0; i < cue.syllables; i++) {
        const last = i === cue.syllables - 1;
        const semis = (Math.random() * 4 - 2) + (last ? (cue.question ? 4 : -3) : 0);
        const f = base * Math.pow(2, semis / 12);
        tone(out, t + i * 0.075, i % 2 ? "triangle" : "square", f, f * (last && cue.question ? 1.12 : 0.97), 0.06, 0.28);
      }
    },
  };
  const LENGTH = { place: 0.15, break: 0.25, join: 0.15, leave: 0.2, ding: 0.45, babble: 0.65 };
  const GAIN = { place: 0.8, break: 0.7, join: 0.6, leave: 0.55, ding: 0.5, babble: 0.55 };

  return {
    get on() { return on; },
    /** Turn sound on/off (call from a click: that's what lets the browser start audio). */
    toggle() {
      on = !on;
      try { localStorage.setItem(STORE, on ? "on" : "off"); } catch { /* fine: not remembered */ }
      if (on) { ensure(); ctx.resume(); RECIPES.join(voice(0, 0.5, 0.2), ctx.currentTime + 0.02); }
      else ctx?.suspend();
      return on;
    },
    /** Play cues; `pan` maps a cue to -1 (left) … 1 (right) of the screen. */
    play(cues, pan) {
      if (!on || !cues.length) return;
      ensure();
      if (ctx.state === "suspended") return;  // not yet allowed: needs a click on the toggle
      const now = performance.now();
      for (const cue of cues) {
        if (voices >= MAX_VOICES || !gate(cue, now)) continue;
        const recipe = RECIPES[cue.sound];
        if (!recipe) throw new Error(`no sound recipe for "${cue.sound}"`);
        recipe(voice(pan(cue), GAIN[cue.sound], LENGTH[cue.sound]), ctx.currentTime + 0.01, cue);
      }
    },
  };
}
