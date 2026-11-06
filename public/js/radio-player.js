// The browser side of radio.js: one <audio> element, the station remembered. Browsers only start audio after a
// click, so a remembered station resumes on the first click or key press anywhere on the page. HLS stations play
// natively where the browser can (Safari), else through hls.js, loaded only when one is picked.

import { nextStation, stationById } from "./radio.js";

const STORE = "office.radio";
const VOLUME = 0.35;
const HLS_JS = "/vendor/hls.js-1.7.4/hls.light.min.mjs";

export function createRadio() {
  const audio = new Audio();
  audio.preload = "none";
  audio.volume = VOLUME;
  let id = null;
  try { id = stationById(localStorage.getItem(STORE))?.id ?? null; } catch { /* storage blocked: off */ }

  let hls = null;
  let attached = null;

  /** Points the <audio> at `s`: a plain stream URL, or an HLS playlist (native, or via hls.js), looped. */
  const attach = async (s) => {
    hls?.destroy();
    hls = null;
    attached = s.id;
    audio.loop = !!s.hls;
    if (s.hls && !audio.canPlayType("application/vnd.apple.mpegurl")) {
      const { default: Hls } = await import(HLS_JS);
      if (!Hls.isSupported()) throw new Error("this browser can't play HLS");
      if (attached !== s.id) return;
      hls = new Hls();
      hls.loadSource(s.url);
      hls.attachMedia(audio);
    } else {
      audio.src = s.url;
    }
  };

  const play = async () => {
    const s = stationById(id);
    if (!s) { hls?.destroy(); hls = null; attached = null; audio.pause(); audio.removeAttribute("src"); audio.load(); return; }
    try {
      if (attached !== s.id) await attach(s);
      if (stationById(id)?.id !== s.id) return;
      await audio.play();
    } catch (e) {
      if (e.name !== "NotAllowedError") console.error(`radio ${s.name}: ${e.message}`);
    }
  };
  if (id) {
    const resume = () => { removeEventListener("pointerdown", resume); removeEventListener("keydown", resume); play(); };
    addEventListener("pointerdown", resume);
    addEventListener("keydown", resume);
  }

  return {
    get station() { return stationById(id); },
    /** Off → first station → … → off; returns the station now playing (or null). */
    next() {
      id = nextStation(id);
      try { if (id) localStorage.setItem(STORE, id); else localStorage.removeItem(STORE); } catch { /* fine: not remembered */ }
      play();
      return stationById(id);
    },
  };
}
