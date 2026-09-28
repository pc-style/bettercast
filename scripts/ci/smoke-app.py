"""Disposable runner only: launch without granting permissions or configuring providers."""
import pathlib
import plistlib
import subprocess
import sys
import time

app = pathlib.Path(sys.argv[1]).resolve()
out = pathlib.Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)
with (app / "Contents/Info.plist").open("rb") as handle:
    executable = plistlib.load(handle)["CFBundleExecutable"]

# Direct launch retains the exact child PID for liveness and cleanup. Do not
# use pgrep or terminate other applications. No TCC/Accessibility automation.
with (out / "launch.log").open("w") as log:
    process = subprocess.Popen([str(app / "Contents/MacOS" / executable)], stdout=log, stderr=log)
    try:
        for _ in range(30):
            time.sleep(1)
            if process.poll() is not None:
                raise RuntimeError(f"App exited during smoke test: {process.returncode}")
        print("App process remained alive for 30 seconds; this does not prove responsiveness.")
        try:
            capture = subprocess.run(
                ["/usr/sbin/screencapture", "-x", str(out / "desktop.png")],
                capture_output=True, text=True, timeout=10,
            )
            print("Screenshot exit status:", capture.returncode)
            print(capture.stderr)
        except subprocess.TimeoutExpired:
            print("Screenshot unavailable: capture timed out. No permissions were granted.")
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
