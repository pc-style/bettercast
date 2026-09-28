//! Headless full-loop harness for the Bettercast launcher panel.
//!
//! Zero-config TypeScript apps have no hook for app-authored Zig tests
//! (`native test` only compiles the generated wiring and refreshes the
//! model contract), so this tiny build reuses the SDK's own `addAppArtifacts`
//! over the real app tree (app_root "..") and adds one extra test binary
//! that imports the staged app module: the compiled TS core, the real
//! src/app.native, and the null-platform TestHarness. No window is ever
//! created; nothing touches the OS.
//!
//! Run through scripts/harness-test.sh (it writes build.zig.zon with the
//! local SDK path, runs `zig build keys-test`, then zig-out/bin/keys-test).

const std = @import("std");
const native_sdk = @import("native_sdk");

pub fn build(b: *std.Build) void {
    const dep = b.dependency("native_sdk", .{});
    const artifacts = native_sdk.addAppArtifacts(b, dep, .{
        .name = "bettercast",
        .manifest = "app.json",
        .app_root = "..",
    });
    const app_mod = artifacts.tests.root_module;
    const sdk_mod = app_mod.import_table.get("native_sdk").?;

    const test_mod = b.createModule(.{
        .root_source_file = b.path("keys_test.zig"),
        .target = app_mod.resolved_target,
        .optimize = app_mod.optimize,
    });
    test_mod.addImport("app", app_mod);
    test_mod.addImport("native_sdk", sdk_mod);
    test_mod.addImport("app_manifest_zon", app_mod.import_table.get("app_manifest_zon").?);
    // The Manage window's compiled markup view, staged beside a tiny
    // registry (the generated launcher's window_views.zig is private to
    // its wiring module).
    const staged = b.addWriteFiles();
    _ = staged.addCopyFile(b.path("../src/windows/manage.native"), "windows/manage.native");
    const views_root = staged.add("window_views.zig",
        \\const std = @import("std");
        \\const native_sdk = @import("native_sdk");
        \\const core = @import("app").core;
        \\const canvas = native_sdk.canvas;
        \\const App = native_sdk.TsUiApp(core).App;
        \\const sources = [_]canvas.ui_markup.SourceFile{
        \\    .{ .path = "manage.native", .source = @embedFile("windows/manage.native") },
        \\};
        \\const Manage = canvas.CompiledMarkupImports(core.Model, core.Msg, "manage.native", &sources);
        \\pub fn build(ui: *App.Ui, model: *const core.Model, label: []const u8) App.Ui.Node {
        \\    if (std.mem.eql(u8, label, "manage")) return Manage.build(ui, model);
        \\    @panic("no view for window label");
        \\}
        \\
    );
    const views_mod = b.createModule(.{ .root_source_file = views_root, .target = app_mod.resolved_target, .optimize = app_mod.optimize });
    views_mod.addImport("native_sdk", sdk_mod);
    views_mod.addImport("app", app_mod);
    test_mod.addImport("window_views", views_mod);
    const keys_tests = b.addTest(.{ .name = "keys-test", .root_module = test_mod });
    // Installed and run directly by scripts/harness-test.sh so the test's
    // stderr (the snapshot evidence) prints even when everything passes.
    const install = b.addInstallArtifact(keys_tests, .{});
    const step = b.step("keys-test", "Build the headless launcher keyboard/a11y full-loop test");
    step.dependOn(&install.step);
}
