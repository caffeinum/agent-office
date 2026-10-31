// Where frames come from: the office's WebSocket (real offices — real data only) or, for ?demo=1 only,
// an in-page simulation. Both emit the same frames: snapshot, then deltas.

import { createDemo } from "./demo.js";

const BACKOFF = [1000, 2000, 4000, 8000, 15000];

/**
 * onFrame(frame) gets every server frame; onStatus({state, detail}) gets connection changes:
 * connecting | live | reconnecting | not-found | unauthorized | error.
 */
export function connectLive({ office, key, onFrame, onStatus }) {
  let ws = null, tries = 0, closed = false, gotSnapshot = false, timer = 0, ping = 0;
  // the key rides in a WebSocket subprotocol (browsers can't set headers), never in the URL, so it stays out of logs
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/o/${encodeURIComponent(office)}/ws`;
  const protocols = ["agent-office", `ao-key.${key}`];

  async function probe() {
    // A failed upgrade hides the HTTP status from the browser, so ask the same URL as a plain GET:
    // 404 = no such office, 401/403 = bad key, 426 = fine (it wanted an upgrade) → transient.
    try {
      const r = await fetch(url.replace(/^ws/, "http"), { headers: { accept: "application/json", authorization: `Bearer ${key}` } });
      let msg = "";
      try { msg = (await r.json()).error ?? ""; } catch { /* non-JSON body */ }
      if (r.status === 404) return { state: "not-found", detail: msg || "no such office" };
      if (r.status === 401 || r.status === 403) return { state: "unauthorized", detail: msg || "this key doesn't open this office" };
      return null;
    } catch {
      return null;
    }
  }

  function open() {
    if (closed) return;
    onStatus({ state: tries ? "reconnecting" : "connecting", detail: tries ? `retry ${tries}` : "" });
    ws = new WebSocket(url, protocols);
    ws.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { onStatus({ state: "error", detail: "server sent a non-JSON frame" }); return; }
      if (frame.type === "pong") return;
      if (frame.type === "snapshot") { gotSnapshot = true; tries = 0; onStatus({ state: "live", detail: "" }); }
      onFrame(frame);
    };
    ws.onopen = () => {
      clearInterval(ping);
      // answered by the server's auto-response without waking the office (hibernation stays on)
      ping = setInterval(() => { if (ws?.readyState === 1) ws.send('{"type":"ping"}'); }, 25000);
    };
    ws.onclose = async (ev) => {
      clearInterval(ping);
      if (closed) return;
      if (ev.code === 4404) { onStatus({ state: "not-found", detail: ev.reason || "no such office" }); return; }
      if (ev.code === 4401 || ev.code === 4403) { onStatus({ state: "unauthorized", detail: ev.reason || "bad key" }); return; }
      if (!gotSnapshot) {
        const fatal = await probe();
        if (fatal) { onStatus(fatal); return; }
      }
      const wait = BACKOFF[Math.min(tries, BACKOFF.length - 1)];
      tries++;
      onStatus({ state: "reconnecting", detail: `reconnecting in ${Math.round(wait / 1000)}s` });
      timer = setTimeout(open, wait);
    };
  }
  open();

  return {
    send(msg) {
      if (!ws || ws.readyState !== 1) throw new Error("not connected to the office right now — try again in a moment");
      ws.send(JSON.stringify(msg));
    },
    close() { closed = true; clearTimeout(timer); clearInterval(ping); ws?.close(); },
  };
}

export function connectDemo({ onFrame, onStatus, crowd = 0 }) {
  onStatus({ state: "live", detail: "demo" });
  const demo = createDemo(onFrame, { crowd });
  return { send: (msg) => demo.receive(msg), close: () => demo.stop() };
}
