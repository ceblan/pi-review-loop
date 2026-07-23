// Idempotently patch glimpseui's native Linux backend to open as a normal
// GTK toplevel instead of a gtk4-layer-shell Overlay surface, then rebuild
// the native binary. Hyprland cannot tile layer-shell surfaces and renders
// them with no window chrome; as a toplevel the review window tiles next to
// the focused window (the kitty running pi) like a normal app.
//
// Best-effort: if the patch context is not found (e.g. a newer glimpseui
// version changed the source) or the build fails (missing toolchain / deps),
// log a warning and exit 0 so `npm install` is not broken — Glimpse will
// fall back to its Chromium-CDP backend instead.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const glimpseRoot = join(__dirname, "..", "node_modules", "glimpseui");
const mainRs = join(glimpseRoot, "src", "linux", "src", "main.rs");
const MARKER = "Patched by pi-review-loop";

function fail(msg) {
  console.warn(`[patch-glimpseui] skipped: ${msg}`);
  process.exit(0); // best-effort: do not break npm install
}

if (!existsSync(mainRs)) fail(`${mainRs} not found (glimpseui not installed?)`);

let src = readFileSync(mainRs, "utf8");

if (!src.includes(MARKER)) {
  const block1 = `    window.init_layer_shell();
    window.set_layer(Layer::Overlay);
    window.set_exclusive_zone(-1);
    window.set_title(Some(&args.title));
    window.set_default_size(args.width, args.height);

    if args.click_through {
        window.set_keyboard_mode(KeyboardMode::None);
    } else {
        window.set_keyboard_mode(KeyboardMode::OnDemand);
    }

    window.set_anchor(Edge::Top, true);
    window.set_anchor(Edge::Left, true);

    let offset_x = args.effective_offset_x();
    let offset_y = args.effective_offset_y();
    let initial_cursor = hyprland::current_cursor_pos().ok();
    let (init_x, init_y) = if args.follow_cursor {
        if let Some(cursor_pos) = initial_cursor {
            let (x, y) = cursor::compute_target(
                cursor_pos.x as f64,
                cursor_pos.y as f64,
                args.width as f64,
                args.height as f64,
                args.cursor_anchor.as_deref(),
                offset_x,
                offset_y,
            );
            (x.round() as i32, y.round() as i32)
        } else {
            resolve_initial_position(args, &display)
        }
    } else {
        resolve_initial_position(args, &display)
    };
    place_window_at_global_position(&window, &display, (init_x as f64, init_y as f64));`;

  const repl1 = `    // ${MARKER}: open as a normal GTK toplevel instead of a
    // gtk4-layer-shell Overlay surface. The compositor (Hyprland) cannot tile
    // layer-shell surfaces and renders them with no window chrome, so the
    // review window floated centered over everything. As a toplevel it tiles
    // next to the focused window (the kitty running pi) like a normal app.
    // Follow-cursor / overlay positioning is unused by pi-review-loop.
    window.set_title(Some(&args.title));
    window.set_default_size(args.width, args.height);

    let offset_x = args.effective_offset_x();
    let offset_y = args.effective_offset_y();
    let initial_cursor = hyprland::current_cursor_pos().ok();
    // No layer-shell positioning; init_x/init_y only seed the (unused) cursor-follow spring.
    let (init_x, init_y): (i32, i32) = (0, 0);`;

  const block2 = `    if linux_follow_cursor_supported() {
        setup_cursor_tracking(`;
  const repl2 = `    if args.follow_cursor && linux_follow_cursor_supported() {
        setup_cursor_tracking(`;

  if (!src.includes(block1)) fail("layer-shell block not found (glimpseui source changed?)");
  src = src.replace(block1, repl1);
  if (!src.includes(block2)) fail("follow-cursor gate not found (glimpseui source changed?)");
  src = src.replace(block2, repl2);

  writeFileSync(mainRs, src);
  console.log("[patch-glimpseui] patched main.rs → toplevel window model");
} else {
  console.log("[patch-glimpseui] main.rs already patched");
}

// Rebuild the native binary from the patched source.
console.log("[patch-glimpseui] building native binary (npm run build:linux)…");
const r = spawnSync("npm", ["run", "build:linux"], { cwd: glimpseRoot, stdio: "inherit" });
if (r.status !== 0) fail(`build:linux exited ${r.status} (missing webkitgtk-6.0 / cargo config?)`);
console.log("[patch-glimpseui] done");
