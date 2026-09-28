//! Headless full-loop keyboard + accessibility spike for the launcher panel.
//!
//! Drives the REAL compiled TypeScript core (src/core.ts) and the REAL
//! src/app.native through the SDK's null-platform TestHarness: raw
//! gpu_surface key/text events go through the same runtime routing a Mac
//! keyboard does (focus, retained text editor, on-input stamping, anchored
//! surfaces, Tab traversal), and assertions read the rebuilt widget tree,
//! runtime focus, and the automation snapshot text. No window, no OS.
//!
//! Run: scripts/harness-test.sh (from the repo root).

const std = @import("std");
const native_sdk = @import("native_sdk");
const app = @import("app");
const manifest = @import("app_manifest_zon");
const window_views = @import("window_views");

const canvas = native_sdk.canvas;
const geometry = native_sdk.geometry;
const automation = native_sdk.automation;

const Adapter = native_sdk.TsUiApp(app.core);
const App = Adapter.App;
const scene = native_sdk.app_manifest.shellConfigFrom(manifest);
const canvas_label = native_sdk.app_manifest.firstGpuSurfaceLabel(scene);

const width: f32 = 720;
const height: f32 = 460;

const Fixture = struct {
    harness: *native_sdk.TestHarness(),
    state: *App,
    handle: native_sdk.App,
    frame_index: u64 = 1,

    fn create() !*Fixture {
        const self = try std.heap.page_allocator.create(Fixture);
        const harness = try native_sdk.TestHarness().create(std.testing.allocator, .{ .size = geometry.SizeF.init(width, height) });
        harness.null_platform.gpu_surfaces = true;
        const env = [_]Adapter.EnvValue{.{ .msg = "env_test_mode", .value = "1" }};
        const state = try Adapter.create(std.heap.page_allocator, .{ .env_values = &env }, .{
            .name = manifest.name,
            .scene = scene,
            .canvas_label = canvas_label,
            .markup = .{ .source = app.appMarkup() },
            .on_command = app.core.commandMsg,
            .window_view = window_views.build,
        });
        self.* = .{ .harness = harness, .state = state, .handle = state.app() };
        try harness.start(self.handle);
        try self.frame();
        return self;
    }

    fn destroy(self: *Fixture) void {
        self.state.destroy();
        self.harness.destroy(std.testing.allocator);
        std.heap.page_allocator.destroy(self);
    }

    fn frame(self: *Fixture) !void {
        self.frame_index += 1;
        try self.harness.runtime.dispatchPlatformEvent(self.handle, .{ .gpu_surface_frame = .{
            .label = canvas_label,
            .size = geometry.SizeF.init(width, height),
            .scale_factor = 2,
            .frame_index = self.frame_index,
            .timestamp_ns = self.frame_index * 16_000_000,
            .nonblank = true,
        } });
    }

    fn command(self: *Fixture, id: []const u8) !void {
        try self.harness.runtime.dispatchPlatformEvent(self.handle, .{ .shortcut = .{ .id = id, .key = "" } });
        try self.frame();
    }

    fn key(self: *Fixture, name: []const u8) !void {
        try self.keyMods(name, .{});
    }

    fn keyMods(self: *Fixture, name: []const u8, modifiers: native_sdk.platform.ShortcutModifiers) !void {
        try self.harness.runtime.dispatchPlatformEvent(self.handle, .{ .gpu_surface_input = .{
            .label = canvas_label,
            .kind = .key_down,
            .key = name,
            .modifiers = modifiers,
        } });
        try self.harness.runtime.dispatchPlatformEvent(self.handle, .{ .gpu_surface_input = .{
            .label = canvas_label,
            .kind = .key_up,
            .key = name,
            .modifiers = modifiers,
        } });
        try self.frame();
    }

    fn typeText(self: *Fixture, text: []const u8) !void {
        try self.harness.runtime.dispatchPlatformEvent(self.handle, .{ .gpu_surface_input = .{
            .label = canvas_label,
            .kind = .text_input,
            .text = text,
        } });
        try self.frame();
    }

    fn model(self: *Fixture) *const app.core.Model {
        return &self.state.model;
    }

    fn root(self: *Fixture) canvas.Widget {
        return self.state.tree.?.root;
    }

    fn focusedId(self: *Fixture) canvas.ObjectId {
        return self.harness.runtime.views[0].canvas_widget_focused_id;
    }

    fn focusVisibleId(self: *Fixture) canvas.ObjectId {
        return self.harness.runtime.views[0].canvas_widget_focus_visible_id;
    }

    fn findKind(self: *Fixture, kind: canvas.WidgetKind) ?canvas.Widget {
        return findKindIn(self.root(), kind);
    }

    fn findById(self: *Fixture, id: canvas.ObjectId) ?canvas.Widget {
        return findIdIn(self.root(), id);
    }

    fn snapshot(self: *Fixture, title: []const u8, buffer: []u8) ![]const u8 {
        var writer = std.Io.Writer.fixed(buffer);
        try automation.snapshot.writeText(self.harness.runtime.automationSnapshot(title), &writer);
        return writer.buffered();
    }

    fn printSnapshot(self: *Fixture, title: []const u8) !void {
        var buffer: [65536]u8 = undefined;
        const text = try self.snapshot(title, &buffer);
        std.debug.print("\n===== snapshot: {s} =====\n", .{title});
        var lines = std.mem.splitScalar(u8, text, '\n');
        while (lines.next()) |line| {
            // Widget lines only (the evidence); skip runtime counters.
            if (std.mem.indexOf(u8, line, "widget ") != null or std.mem.indexOf(u8, line, "focus") != null) {
                std.debug.print("{s}\n", .{line});
            }
        }
    }

    fn expectSnapshotContains(self: *Fixture, needle: []const u8) !void {
        var buffer: [65536]u8 = undefined;
        const text = try self.snapshot("check", &buffer);
        if (std.mem.indexOf(u8, text, needle) == null) {
            std.debug.print("\nMISSING in snapshot: {s}\n{s}\n", .{ needle, text });
            return error.TestExpectedSnapshotText;
        }
    }

    fn expectSnapshotLacks(self: *Fixture, needle: []const u8) !void {
        var buffer: [65536]u8 = undefined;
        const text = try self.snapshot("check", &buffer);
        if (std.mem.indexOf(u8, text, needle) != null) {
            std.debug.print("\nUNEXPECTED in snapshot: {s}\n{s}\n", .{ needle, text });
            return error.TestUnexpectedSnapshotText;
        }
    }
};

fn findKindIn(widget: canvas.Widget, kind: canvas.WidgetKind) ?canvas.Widget {
    if (widget.kind == kind) return widget;
    for (widget.children) |child| {
        if (findKindIn(child, kind)) |found| return found;
    }
    return null;
}

fn findIdIn(widget: canvas.Widget, id: canvas.ObjectId) ?canvas.Widget {
    if (widget.id == id) return widget;
    for (widget.children) |child| {
        if (findIdIn(child, id)) |found| return found;
    }
    return null;
}

fn searchFieldId(f: *Fixture) !canvas.ObjectId {
    const field = f.findKind(.search_field) orelse return error.NoSearchField;
    return field.id;
}

fn expectSearchFocused(f: *Fixture) !void {
    const id = try searchFieldId(f);
    if (f.focusedId() != id) {
        std.debug.print("\nfocus is #{d}, search field is #{d}\n", .{ f.focusedId(), id });
        return error.SearchFieldNotFocused;
    }
}

fn expectQuery(f: *Fixture, expected: []const u8) !void {
    try std.testing.expectEqualStrings(expected, f.model().query.text);
    const field = f.findKind(.search_field) orelse return error.NoSearchField;
    try std.testing.expectEqualStrings(expected, field.text);
}

fn openSeededPanel(f: *Fixture) !void {
    try f.command("test.seed");
    try f.command("panel.show");
    try std.testing.expect(f.model().panelVisible);
}

test "launcher keyboard: type, arrows, Return, Esc, cmd-K, Tab, accessible names" {
    const f = try Fixture.create();
    defer f.destroy();
    try openSeededPanel(f);
    try f.printSnapshot("panel shown (empty query)");

    // 1. The search field has first focus (autofocus) and an accessible name.
    try expectSearchFocused(f);
    try f.expectSnapshotContains("name=\"Search Bettercast\"");

    // 2. Type to filter.
    try f.typeText("fix");
    try expectQuery(f, "fix");
    try expectSearchFocused(f);
    try f.expectSnapshotContains("name=\"Fixture Browser, Application\"");
    try f.expectSnapshotLacks("name=\"Q, Application\"");
    try f.printSnapshot("typed 'fix'");
    try std.testing.expectEqual(@as(i64, 0), f.model().selected);

    // 3. ArrowDown / ArrowUp move the model selection while typing focus stays.
    try f.key("arrowdown");
    try std.testing.expectEqual(@as(i64, 1), f.model().selected);
    try expectSearchFocused(f);
    try f.key("arrowdown");
    try std.testing.expectEqual(@as(i64, 2), f.model().selected);
    try f.key("arrowup");
    try std.testing.expectEqual(@as(i64, 1), f.model().selected);
    try expectSearchFocused(f);
    try f.printSnapshot("after down, down, up (selected=1)");

    // 4. Typing after arrows appends at the END (caret not left at start).
    try f.key("arrowup");
    try std.testing.expectEqual(@as(i64, 0), f.model().selected);
    try f.typeText("t");
    try expectQuery(f, "fixt");
    try expectSearchFocused(f);

    // 4b. Even with the caret moved left, ArrowDown/ArrowUp leave it at the
    //     end, so the next keystroke appends (model and runtime agree).
    const before_down = try searchFieldId(f);
    try f.key("arrowleft");
    try f.key("arrowleft");
    try f.key("arrowdown");
    try std.testing.expectEqual(before_down, try searchFieldId(f)); // ArrowDown keeps the field
    try f.typeText("u");
    try expectQuery(f, "fixtu");
    try f.key("arrowleft");
    try f.key("arrowup");
    try f.typeText("r");
    try expectQuery(f, "fixtur");
    try f.key("backspace");
    try f.key("backspace");
    try expectQuery(f, "fixt");
    try std.testing.expectEqual(@as(i64, 0), f.model().selected);
    try expectSearchFocused(f);

    // 5. cmd-K (app.json shortcut "actions.toggle") opens the actions menu;
    //    arrows walk the ACTION selection; Esc closes it and keeps the query.
    try f.command("actions.toggle");
    try std.testing.expect(f.model().actionsOpen);
    try f.printSnapshot("actions menu open");
    try f.expectSnapshotContains("menu_item");
    try f.key("arrowdown");
    try std.testing.expectEqual(@as(i64, 1), f.model().actionSelected);
    try std.testing.expectEqual(@as(i64, 0), f.model().selected);
    try f.key("escape");
    try std.testing.expect(!f.model().actionsOpen);
    try expectQuery(f, "fixt");
    try expectSearchFocused(f);

    // 6. Esc with text clears the query; focus stays in the field.
    try f.key("escape");
    try expectQuery(f, "");
    try std.testing.expect(f.model().panelVisible);
    try expectSearchFocused(f);

    // 7. Tab walks focusable controls with a visible focus ring, in order.
    try f.typeText("fix");
    const field_id = try searchFieldId(f);
    std.debug.print("\n===== Tab order from the search field =====\n", .{});
    var seen_row = false;
    var seen_actions = false;
    var seen_manage = false;
    var tabs: usize = 0;
    while (tabs < 12) : (tabs += 1) {
        try f.key("tab");
        const id = f.focusedId();
        const w = f.findById(id) orelse break;
        const visible = f.focusVisibleId() == id;
        std.debug.print("tab {d}: #{d} kind={s} name=\"{s}\" text=\"{s}\" focus_visible={}\n", .{ tabs + 1, id, @tagName(w.kind), w.semantics.label, w.text, visible });
        try std.testing.expect(visible);
        // Every Tab stop announces a name (label or visible text).
        try std.testing.expect(w.semantics.label.len > 0 or w.text.len > 0);
        if (w.kind == .list_item) seen_row = true;
        if (w.kind == .button and std.mem.eql(u8, w.text, "Actions")) seen_actions = true;
        if (w.kind == .button and std.mem.indexOf(u8, w.text, "Manage") != null) seen_manage = true;
        if (id == field_id) break;
    }
    try std.testing.expect(seen_row);
    try std.testing.expect(seen_actions);
    try std.testing.expect(seen_manage);

    // 8. Return on a Tab-focused row runs THAT row (Enter = row activation).
    try f.key("tab"); // search field -> results scroll region
    try std.testing.expectEqual(canvas.WidgetKind.scroll_view, f.findById(f.focusedId()).?.kind);
    try f.key("tab"); // -> first row
    const row = f.findById(f.focusedId()) orelse return error.NoFocus;
    try std.testing.expectEqual(canvas.WidgetKind.list_item, row.kind);
    try f.key("enter");
    std.debug.print("\nrow Return notice: {s}\n", .{f.model().notice});
    try std.testing.expect(std.mem.startsWith(u8, f.model().notice, "dry-run: open /Applications/Fixture Browser.app"));
    try std.testing.expect(!f.model().panelVisible);

    // 9. Return from the search field runs the SELECTED row.
    try f.command("panel.show");
    try expectSearchFocused(f);
    try f.typeText("q");
    try f.key("enter");
    std.debug.print("field Return notice: {s}\n", .{f.model().notice});
    try std.testing.expect(std.mem.startsWith(u8, f.model().notice, "dry-run: open /Applications/Q.app"));
    try std.testing.expect(!f.model().panelVisible);

    // 10. Esc goes back from a pushed screen, then hides the panel.
    try f.command("clipboard.open");
    try std.testing.expect(f.model().panelVisible);
    try std.testing.expect(f.model().screen == .clipboard);
    try expectSearchFocused(f);
    try f.expectSnapshotContains("name=\"Search clipboard history\"");
    try f.expectSnapshotContains("name=\"Back\"");
    try f.typeText("caf");
    try f.expectSnapshotContains("role=listitem name=\"naïve café — 日本語 ✓, Clipboard\"");
    try f.key("escape"); // clears the query
    try std.testing.expect(f.model().screen == .clipboard);
    try f.key("escape"); // back to root
    try std.testing.expect(f.model().screen == .root);
    try std.testing.expect(f.model().panelVisible);
    try expectSearchFocused(f);
    try f.key("escape"); // empty query on root: hide
    try std.testing.expect(!f.model().panelVisible);
}

// ---------------------------------------------------------------- views

/// One gpu_surface (main panel or a declared window's canvas).
const Surface = struct {
    window_id: native_sdk.platform.WindowId,
    label: []const u8,
    size: geometry.SizeF,
};

const main_surface = Surface{ .window_id = 1, .label = canvas_label, .size = geometry.SizeF.init(width, height) };

fn frameOn(f: *Fixture, s: Surface) !void {
    f.frame_index += 1;
    try f.harness.runtime.dispatchPlatformEvent(f.handle, .{ .gpu_surface_frame = .{
        .window_id = s.window_id,
        .label = s.label,
        .size = s.size,
        .scale_factor = 2,
        .frame_index = f.frame_index,
        .timestamp_ns = f.frame_index * 16_000_000,
        .nonblank = true,
    } });
}

fn keyOn(f: *Fixture, s: Surface, name: []const u8, modifiers: native_sdk.platform.ShortcutModifiers) !void {
    try f.harness.runtime.dispatchPlatformEvent(f.handle, .{ .gpu_surface_input = .{ .window_id = s.window_id, .label = s.label, .kind = .key_down, .key = name, .modifiers = modifiers } });
    try f.harness.runtime.dispatchPlatformEvent(f.handle, .{ .gpu_surface_input = .{ .window_id = s.window_id, .label = s.label, .kind = .key_up, .key = name, .modifiers = modifiers } });
    try frameOn(f, s);
}

fn typeOn(f: *Fixture, s: Surface, text: []const u8) !void {
    try f.harness.runtime.dispatchPlatformEvent(f.handle, .{ .gpu_surface_input = .{ .window_id = s.window_id, .label = s.label, .kind = .text_input, .text = text } });
    try frameOn(f, s);
}

fn focusedOn(f: *Fixture, s: Surface) !canvas.Widget {
    const index = f.harness.runtime.findViewIndex(s.window_id, s.label) orelse return error.NoView;
    const id = f.harness.runtime.views[index].canvas_widget_focused_id;
    const layout = try f.harness.runtime.canvasWidgetLayout(s.window_id, s.label);
    for (layout.nodes) |node| {
        if (node.widget.id == id) return node.widget;
    }
    return error.NoFocus;
}

fn focusVisibleOn(f: *Fixture, s: Surface) !bool {
    const index = f.harness.runtime.findViewIndex(s.window_id, s.label) orelse return error.NoView;
    const view = f.harness.runtime.views[index];
    return view.canvas_widget_focus_visible_id == view.canvas_widget_focused_id;
}

/// Press Tab until the focused widget's accessible name (label, else
/// text) equals `name`; every stop must be named and focus-visible.
fn tabTo(f: *Fixture, s: Surface, name: []const u8, max: usize) !canvas.Widget {
    var i: usize = 0;
    while (i < max) : (i += 1) {
        try keyOn(f, s, "tab", .{});
        const w = try focusedOn(f, s);
        const shown = if (w.semantics.label.len > 0) w.semantics.label else w.text;
        std.debug.print("  tab[{s}] kind={s} name=\"{s}\" focus_visible={}\n", .{ s.label, @tagName(w.kind), shown, try focusVisibleOn(f, s) });
        try std.testing.expect(shown.len > 0 or w.kind == .tree or w.kind == .radio_group or w.kind == .toggle_group);
        try std.testing.expect(try focusVisibleOn(f, s));
        if (std.mem.eql(u8, shown, name)) return w;
    }
    std.debug.print("\nnever reached \"{s}\" by Tab\n", .{name});
    return error.TabTargetNotFound;
}

fn manageSurface(f: *Fixture) !Surface {
    var buffer: [native_sdk.platform.max_windows]native_sdk.platform.WindowInfo = undefined;
    for (f.harness.runtime.listWindows(&buffer)) |info| {
        if (std.mem.eql(u8, info.label, "manage")) return .{ .window_id = info.id, .label = "manage-canvas", .size = geometry.SizeF.init(760, 540) };
    }
    return error.NoManageWindow;
}

test "views: sections, Cmd+K delete with confirm, clipboard filter, AI screen, Manage by keyboard" {
    const f = try Fixture.create();
    defer f.destroy();
    try openSeededPanel(f);

    // 1. One result list with section headers (no side pane).
    try f.expectSnapshotContains("role=text name=\"Commands\"");
    try f.expectSnapshotContains("role=text name=\"Snippets\"");
    try f.expectSnapshotContains("role=button name=\"Open Command\"");

    // 1b. The list follows the keyboard selection (scroll-into-view): the
    //     empty root has 9 rows + 2 headers (> the 354pt viewport).
    try f.expectSnapshotContains("scroll=[offset=0,");
    var downs: usize = 0;
    while (downs < 8) : (downs += 1) try f.key("arrowdown");
    try std.testing.expectEqual(@as(i64, 8), f.model().selected);
    try f.expectSnapshotLacks("scroll=[offset=0,");
    try f.expectSnapshotContains("list=[index=8,count=9] state=[selected]");
    std.debug.print("after 8 downs: resultsScroll={d}\n", .{f.model().resultsScroll});
    downs = 0;
    while (downs < 8) : (downs += 1) try f.key("arrowup");
    try std.testing.expectEqual(@as(i64, 0), f.model().selected);
    try f.expectSnapshotContains("scroll=[offset=0,");

    // 2. Cmd+K -> "Delete Snippet…" opens the confirm dialog with focus on
    //    the destructive button; Esc cancels, Return deletes.
    try f.typeText("sig");
    try f.command("actions.toggle");
    try f.expectSnapshotContains("role=menuitem name=\"Edit in Manage…\"");
    try f.expectSnapshotContains("role=menuitem name=\"Delete Snippet…\"");
    try f.key("arrowdown");
    try f.key("arrowdown");
    try f.key("arrowdown");
    try f.key("enter");
    try std.testing.expect(f.model().confirm.kind == .snippet);
    try f.printSnapshot("confirm dialog");
    try f.expectSnapshotContains("Delete this snippet?");
    const confirm_focus = try focusedOn(f, main_surface);
    std.debug.print("confirm focus: kind={s} text=\"{s}\"\n", .{ @tagName(confirm_focus.kind), confirm_focus.text });
    try std.testing.expectEqualStrings("Delete", confirm_focus.text);
    try f.key("escape");
    try std.testing.expect(f.model().confirm.kind == .none);
    try std.testing.expectEqual(@as(usize, 4), f.model().snippets.len);
    try expectSearchFocused(f);
    try expectQuery(f, "sig");
    try f.command("actions.toggle");
    try f.key("arrowdown");
    try f.key("arrowdown");
    try f.key("arrowdown");
    try f.key("enter");
    try std.testing.expect(f.model().confirm.kind == .snippet);
    try f.key("enter"); // Return on the focused Delete button
    try std.testing.expect(f.model().confirm.kind == .none);
    try std.testing.expectEqual(@as(usize, 3), f.model().snippets.len);
    try expectSearchFocused(f);
    try f.key("escape"); // clear "sig"

    // 3. Clipboard History: filter chips by keyboard; image rows.
    try f.command("clipboard.open");
    try f.printSnapshot("clipboard history");
    _ = try tabTo(f, main_surface, "Images", 8);
    try f.key("space");
    try std.testing.expect(f.model().clipFilter == .image);
    try f.expectSnapshotContains("name=\"Image 64×48, Clipboard\"");
    try f.expectSnapshotLacks("name=\"hello there, Clipboard\"");
    std.debug.print("thumbs after filter: {d} entries (located={} dataDir=\"{s}\")\n", .{ f.model().thumbs.len, f.model().env.located, f.model().env.dataDir });
    for (f.model().thumbs) |t| std.debug.print("  thumb clip={d} state={s}\n", .{ t.clipId, @tagName(t.state) });
    try f.command("panel.hide");

    // 4. Ask AI screen from the "Ask AI" row: provider chips are shown.
    try f.command("panel.show");
    try f.typeText("zq");
    try f.expectSnapshotContains("name=\"Ask AI “zq”, AI\"");
    try f.key("enter");
    std.debug.print("after Ask AI: screen={s} notice=\"{s}\" status={s}\n", .{ @tagName(f.model().screen), f.model().notice, @tagName(f.model().ai.status) });
    try std.testing.expect(f.model().screen == .ai);
    try f.printSnapshot("ask ai screen");
    try f.expectSnapshotContains("name=\"AI provider\"");
    try f.expectSnapshotContains("Claude Code");
    try f.command("panel.hide");

    // 5. Manage window (menu-bar "Manage Snippets…"): create a snippet with
    //    the keyboard only.
    try f.command("manage.snippets");
    try std.testing.expect(f.model().manageOpen);
    try std.testing.expect(f.model().manageTab == .snippets);
    const m = try manageSurface(f);
    try frameOn(f, m);
    try f.printSnapshot("manage window: snippets");
    try f.expectSnapshotContains("name=\"Settings sections\"");
    _ = try tabTo(f, m, "New Snippet", 12);
    try keyOn(f, m, "space", .{});
    try std.testing.expect(f.model().draft != null);
    // The Name field is autofocused for a new snippet.
    const name_field = try focusedOn(f, m);
    try std.testing.expectEqualStrings("Name", name_field.semantics.label);
    try typeOn(f, m, "Zeta — ünïcode");
    try keyOn(f, m, "tab", .{});
    try std.testing.expectEqualStrings("Keyword", (try focusedOn(f, m)).semantics.label);
    try typeOn(f, m, "zz");
    try keyOn(f, m, "tab", .{});
    try std.testing.expectEqualStrings("Text", (try focusedOn(f, m)).semantics.label);
    try typeOn(f, m, "Line one");
    try keyOn(f, m, "enter", .{});
    try typeOn(f, m, "Line two");
    try keyOn(f, m, "enter", .{ .primary = true }); // Cmd+Return saves
    std.debug.print("after save: snippets={d} draft_null={}\n", .{ f.model().snippets.len, f.model().draft == null });
    try std.testing.expectEqual(@as(usize, 4), f.model().snippets.len);
    const saved = f.model().snippets[3];
    try std.testing.expectEqualStrings("Zeta — ünïcode", saved.name);
    try std.testing.expectEqualStrings("zz", saved.keyword);
    try std.testing.expectEqualStrings("Line one\nLine two", saved.body);

    // 6. Sidebar is a tree: arrows switch sections.
    _ = try tabTo(f, m, "Snippets", 16);
    try keyOn(f, m, "arrowdown", .{});
    try keyOn(f, m, "arrowdown", .{});
    try std.testing.expect(f.model().manageTab == .shortcuts);
    try f.printSnapshot("manage window: shortcuts");

    // 7. Shortcut recorder by keyboard: Space starts, Esc cancels, focus stays.
    _ = try tabTo(f, m, "Record shortcut for Open Bettercast", 12);
    try keyOn(f, m, "space", .{});
    try std.testing.expect(f.model().capturing == .launcher);
    try f.expectSnapshotContains("name=\"Cancel recording for Open Bettercast\"");
    try keyOn(f, m, "escape", .{});
    try std.testing.expect(f.model().capturing == .none);
    try std.testing.expectEqualStrings("Record shortcut for Open Bettercast", (try focusedOn(f, m)).semantics.label);
    try keyOn(f, m, "space", .{});
    try std.testing.expect(f.model().capturing == .launcher);
    try keyOn(f, m, "k", .{ .control = true, .option = true });
    const hk = f.model().hotkeys[0];
    std.debug.print("after Ctrl+Opt+K: capturing={s} launcher keyCode={d} mods={d} notice=\"{s}\"\n", .{ @tagName(f.model().capturing), hk.keyCode, hk.mods, f.model().hotkeyNotice });
    try std.testing.expect(f.model().capturing == .none);
    try std.testing.expectEqual(@as(i64, 40), hk.keyCode); // kVK_ANSI_K
    try std.testing.expectEqual(@as(i64, 12), hk.mods); // option | control
    try f.expectSnapshotContains("Ctrl+Opt+K");
    // ...and back to Opt+Space (Adam's default) with the keyboard only.
    try std.testing.expectEqualStrings("Record shortcut for Open Bettercast", (try focusedOn(f, m)).semantics.label);
    try keyOn(f, m, "space", .{});
    try std.testing.expect(f.model().capturing == .launcher);
    try keyOn(f, m, "space", .{ .option = true });
    try std.testing.expect(f.model().capturing == .none);
    try std.testing.expectEqual(@as(i64, 49), f.model().hotkeys[0].keyCode);
    try std.testing.expectEqual(@as(i64, 4), f.model().hotkeys[0].mods);
    try f.expectSnapshotContains("Opt+Space");

    // 8. The CI hotkey_change sequence, with the exact modifier set
    //    `native automate widget-key ... cmd+space` / `ctrl+alt+cmd+j`
    //    produce (command AND primary for cmd).
    try keyOn(f, m, "space", .{});
    try keyOn(f, m, "space", .{ .command = true, .primary = true });
    std.debug.print("after Cmd+Space: capturing={s} notice=\"{s}\"\n", .{ @tagName(f.model().capturing), f.model().hotkeyNotice });
    try f.expectSnapshotContains("Spotlight");
    try std.testing.expectEqualStrings("Record shortcut for Open Bettercast", (try focusedOn(f, m)).semantics.label);
    try keyOn(f, m, "space", .{});
    try std.testing.expect(f.model().capturing == .launcher);
    try keyOn(f, m, "j", .{ .control = true, .option = true, .command = true, .primary = true });
    std.debug.print("after Ctrl+Opt+Cmd+J: capturing={s} keyCode={d} mods={d} notice=\"{s}\"\n", .{ @tagName(f.model().capturing), f.model().hotkeys[0].keyCode, f.model().hotkeys[0].mods, f.model().hotkeyNotice });
    try f.expectSnapshotContains("Ctrl+Opt+Cmd+J");
}

test "Manage snippets by Tab alone at the minimum window size with a notice bar" {
    const f = try Fixture.create();
    defer f.destroy();
    try openSeededPanel(f);
    // A footer notice (dry-run open) takes space in Manage too, like the
    // CI run's "Copied ..." notice did when Save fell below the fold.
    try f.typeText("q");
    try f.key("enter");
    std.debug.print("notice: \"{s}\"\n", .{f.model().notice});
    try std.testing.expect(f.model().notice.len > 0);

    try f.command("manage.snippets");
    const full = try manageSurface(f);
    // The smallest Manage window core.ts allows (minWidth x minHeight).
    const m = Surface{ .window_id = full.window_id, .label = full.label, .size = geometry.SizeF.init(640, 420) };
    try frameOn(f, m);
    try f.expectSnapshotContains("role=button name=\"Dismiss\"");

    // Create: New Snippet, Name, Keyword, Text, then Tab (not Cmd+Return) to Save.
    _ = try tabTo(f, m, "New Snippet", 12);
    try keyOn(f, m, "space", .{});
    try std.testing.expectEqualStrings("Name", (try focusedOn(f, m)).semantics.label);
    try typeOn(f, m, "Ωmega tab — ïx");
    _ = try tabTo(f, m, "Keyword", 2);
    try typeOn(f, m, "qx9");
    _ = try tabTo(f, m, "Text", 2);
    try typeOn(f, m, "Tab-saved body 7");
    _ = try tabTo(f, m, "Save", 3);
    try keyOn(f, m, "space", .{});
    std.debug.print("after Tab+Space Save: snippets={d} draft_null={}\n", .{ f.model().snippets.len, f.model().draft == null });
    try std.testing.expectEqual(@as(usize, 5), f.model().snippets.len);
    try std.testing.expectEqualStrings("Tab-saved body 7", f.model().snippets[4].body);
    try f.expectSnapshotContains("name=\"Ωmega tab — ïx, keyword qx9\"");

    // Edit: Tab to the saved row, Space opens it, change the body, Tab to Save.
    _ = try tabTo(f, m, "Ωmega tab — ïx, keyword qx9", 24);
    try keyOn(f, m, "space", .{});
    try std.testing.expect(f.model().draft != null);
    _ = try tabTo(f, m, "Text", 12);
    try typeOn(f, m, " edited");
    _ = try tabTo(f, m, "Save", 3);
    try keyOn(f, m, "space", .{});
    std.debug.print("edited body: \"{s}\"\n", .{f.model().snippets[4].body});
    try std.testing.expect(std.mem.indexOf(u8, f.model().snippets[4].body, " edited") != null);

    // Delete: row, Space, Tab to Delete…, Space, confirm with Space.
    _ = try tabTo(f, m, "Ωmega tab — ïx, keyword qx9", 24);
    try keyOn(f, m, "space", .{});
    _ = try tabTo(f, m, "Delete…", 20);
    try keyOn(f, m, "space", .{});
    try std.testing.expect(f.model().confirm.kind == .snippet);
    try f.printSnapshot("manage: delete confirm");
    try std.testing.expectEqualStrings("Delete", (try focusedOn(f, m)).text);
    try keyOn(f, m, "space", .{});
    try std.testing.expect(f.model().confirm.kind == .none);
    try std.testing.expectEqual(@as(usize, 4), f.model().snippets.len);
    try f.expectSnapshotLacks("name=\"Ωmega tab — ïx, keyword qx9\"");

    // Clipboard search: every query word must appear in the clip. The old
    // subsequence match let "hot" hit "hello there" (h..o..t) and the long
    // report clip, like CI's "clip one" hit the longer clip two.
    try f.command("clipboard.open");
    try f.typeText("report 7");
    try f.expectSnapshotContains("name=\"Quarterly sample report");
    try f.expectSnapshotLacks("name=\"hello there, Clipboard\"");
    try f.key("escape");
    try f.typeText("hot");
    try f.expectSnapshotLacks("name=\"hello there, Clipboard\"");
    try f.expectSnapshotLacks("name=\"Quarterly sample report");
}
