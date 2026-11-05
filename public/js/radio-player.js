// The browser side of radio.js: one <audio> element, the station remembered. Browsers only start audio after a
// click, so a remembered station resumes on the first click or key press anywhere on the page.

import { nextStation, stationById } from "./radio.js";

const STORE = "office.radio";
const VOLUME = 0.35;

export function createRadio() {
  const audio = new Audio();
  audio.preload = "none";
  audio.volume = VOLUME;
  let id = null;
  try { id = stationById(localStorage.getItem(STORE))?.id ?? null; } catch { /* storage blocked: off */ }

  const play = () => {
    const s = stationById(id);
    if (!s) { audio.pause(); audio.removeAttribute("src"); audio.load(); return; }
    if (audio.src !== s.url) audio.src = s.url;
    audio.play().catch((e) => { if (e.name !== "NotAllowedError") console.error(`radio ${s.name}: ${e.message}`); });
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
