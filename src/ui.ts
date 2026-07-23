import { fileURLToPath } from "node:url";

// Absolute path to the bundled, self-contained review window HTML.
//
// The controller passes this PATH (not the file contents) to Glimpse's
// loadFile(), which navigates the Chromium backend to file://<path>. Loading
// via file:// is required because Glimpse's alternative path — passing the HTML
// string to open() — base64-encodes it into a data:text/html;base64 URL, and
// Chrome cannot navigate to the ~6 MB data URL this bundle produces (it hangs,
// leaving the window blank). file:// has no such size limit. See
// lat.md/web-ui.md#Bundle loading.
const reviewHtmlUrl = new URL("../web/dist/index.html", import.meta.url);

export function getReviewHtmlPath(): string {
  return fileURLToPath(reviewHtmlUrl);
}
