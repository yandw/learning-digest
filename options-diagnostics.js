/**
 * Fail-loud collector for the options page: captures script errors from the
 * shared modules loaded after this file (settings.js / speech-transcription.js
 * / speech-providers.js). options.js surfaces these on the page when the
 * Speech Provider list comes up empty, instead of leaving a silently disabled
 * dropdown.
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
