"""
Native folder picker.

A browser cannot tell a page where a folder lives on disk. `webkitdirectory`
hands over the files inside it and `showDirectoryPicker()` hands over a handle,
but neither yields an absolute path — deliberately, because a random website
has no business knowing your filesystem layout.

GooseQuill is not a random website. The server runs on the same machine as the
browser and binds to loopback only, so the *server* can open the operating
system's own folder dialog and read the path straight off it. That is what this
does.

The trust boundary is the loopback bind, exactly as it is for
`/api/set_root_folder` — anyone who can reach this endpoint can already set the
working directory by typing it.
"""

from __future__ import annotations

import logging
import subprocess
import sys
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Long enough that a dialog left open while the user goes to find something is
# not snatched away, short enough that a forgotten one eventually frees the
# worker thread it is holding.
DIALOG_TIMEOUT_SECONDS = 180

DEFAULT_PROMPT = "Choose the working documents folder"


class PickerUnavailableError(RuntimeError):
    """No native folder dialog exists on this platform."""


# The dialog is owned by System Events, which is activated first — otherwise it
# can open behind the browser window that asked for it and look like a hang.
# The path arrives through argv rather than being pasted into the script, so a
# folder name containing a quote cannot rewrite the AppleScript around it.
_MACOS_SCRIPT = """
on run argv
    set defaultPath to item 1 of argv
    set thePrompt to item 2 of argv
    tell application "System Events"
        activate
        if defaultPath is "" then
            set chosenFolder to choose folder with prompt thePrompt
        else
            set chosenFolder to choose folder with prompt thePrompt ¬
                default location POSIX file defaultPath
        end if
    end tell
    return POSIX path of chosenFolder
end run
"""

_WINDOWS_SCRIPT = """
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $env:GQ_PICKER_PROMPT
if ($env:GQ_PICKER_START) { $dialog.SelectedPath = $env:GQ_PICKER_START }
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dialog.SelectedPath
}
"""


def _which(command: str) -> bool:
    from shutil import which
    return which(command) is not None


def is_available() -> bool:
    """Whether this platform can show a folder dialog at all.

    Asked before the button is drawn, so a platform without one does not offer
    a control that can only ever fail.
    """
    if sys.platform == "darwin":
        return _which("osascript")
    if sys.platform == "win32":
        return _which("powershell") or _which("pwsh")
    return _which("zenity") or _which("kdialog")


def _run(argv: list[str], env: Optional[dict] = None, stdin: Optional[str] = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        argv,
        input=stdin,
        capture_output=True,
        text=True,
        timeout=DIALOG_TIMEOUT_SECONDS,
        env=env,
    )


def choose_folder(start_dir: Optional[Path] = None, prompt: str = DEFAULT_PROMPT) -> Optional[str]:
    """Open the OS folder dialog and return the chosen absolute path.

    Returns ``None`` when the user cancels, which is an ordinary outcome and
    not an error. Raises :class:`PickerUnavailableError` when the platform has
    no dialog to show, and :class:`subprocess.TimeoutExpired` when one is left
    open past the timeout.
    """
    if not is_available():
        raise PickerUnavailableError(
            f"No native folder dialog is available on this platform ({sys.platform})."
        )

    start = str(start_dir) if start_dir else ""

    if sys.platform == "darwin":
        # A default location that no longer exists makes the dialog fail rather
        # than fall back, so an unreadable one is simply not passed.
        if start and not Path(start).is_dir():
            start = ""
        result = _run(["osascript", "-", start, prompt], stdin=_MACOS_SCRIPT)
        if result.returncode != 0:
            # -128 is the documented "user cancelled" code. A negative return
            # code means the dialog was killed rather than answered — the app
            # shutting down under it, say — which is a cancel from the point of
            # view of anyone waiting on it, not a fault worth reporting.
            stderr = result.stderr or ""
            if result.returncode < 0 or "-128" in stderr or "User canceled" in stderr:
                return None
            raise RuntimeError(stderr.strip() or "The folder dialog failed.")
        return result.stdout.strip() or None

    if sys.platform == "win32":
        import os
        shell = "powershell" if _which("powershell") else "pwsh"
        env = dict(os.environ, GQ_PICKER_PROMPT=prompt, GQ_PICKER_START=start)
        result = _run([shell, "-NoProfile", "-STA", "-Command", _WINDOWS_SCRIPT], env=env)
        if result.returncode != 0:
            raise RuntimeError((result.stderr or "").strip() or "The folder dialog failed.")
        return result.stdout.strip() or None

    if _which("zenity"):
        argv = ["zenity", "--file-selection", "--directory", f"--title={prompt}"]
        if start:
            argv.append(f"--filename={start.rstrip('/')}/")
        result = _run(argv)
        # zenity exits 1 on cancel, which is not a failure.
        if result.returncode != 0:
            return None
        return result.stdout.strip() or None

    argv = ["kdialog", "--getexistingdirectory", start or "."]
    result = _run(argv)
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None
