// Background radio: always-on lo-fi / chill streams the office can play under its foley. One list, so the browser and
// the Apple TV cycle through the same stations.

export const STATIONS = Object.freeze([
  { id: "fluid", name: "SomaFM Fluid", url: "https://ice6.somafm.com/fluid-128-mp3" },
  { id: "groovesalad", name: "SomaFM Groove Salad", url: "https://ice6.somafm.com/groovesalad-128-mp3" },
  { id: "lofi", name: "0R Lo-Fi", url: "https://0nlineradio.radioho.st/0r-lo-fi" },
]);

/** The station after `id` (null = off): off → first → … → last → off. */
export function nextStation(id) {
  if (id == null) return STATIONS[0].id;
  const i = STATIONS.findIndex((s) => s.id === id);
  if (i < 0) throw new Error(`unknown radio station ${JSON.stringify(id)}`);
  return i + 1 < STATIONS.length ? STATIONS[i + 1].id : null;
}

export const stationById = (id) => STATIONS.find((s) => s.id === id) ?? null;
