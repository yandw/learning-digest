/**
 * Fail-loud collector for the options page: captures script errors from the
 * shared modules loaded after this file (settings.js / options.js).
 * Debugging surfaces read window.__ytdScriptErrors; a failing settings.js
 * load leaves a silently empty form, and this is where the reason shows.
 *
 * Lives in an external file because extension pages forbid inline scripts
 * under script-src 'self'. Must be the first script on options.html.
 */
window.__ytdScriptErrors = [];
window.addEventListener("error", function (event) {
  window.__ytdScriptErrors.push(
    (event.message || "Script load error") +
      (event.filename
        ? " @ " + event.filename.split("/").pop() + ":" + event.lineno
        : ""),
  );
});
window.addEventListener("unhandledrejection", function (event) {
  window.__ytdScriptErrors.push(
    "Unhandled rejection: " +
      (event.reason && event.reason.message
        ? event.reason.message
        : String(event.reason)),
  );
});
