// The city's red error banner. Its own dependency-free module so public/js/app.js can show it when
// ./city/app.js itself fails to load.

/** A red banner pinned to the top of the page. Every error gets its own line; the page keeps running. */
export function errorBanner(message) {
  let box = document.getElementById("city-error");
  if (!box) {
    box = document.createElement("div");
    box.id = "city-error";
    box.setAttribute("role", "alert");
    box.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:100;max-height:40vh;overflow:auto;padding:10px 16px;"
      + "background:#b3261e;color:#fff;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word;"
      + "box-shadow:0 2px 12px rgba(0,0,0,.35)";
    document.body.appendChild(box);
  }
  const line = document.createElement("div");
  line.textContent = `city error: ${message}`;
  box.appendChild(line);
}
