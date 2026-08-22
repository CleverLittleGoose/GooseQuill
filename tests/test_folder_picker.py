"""Tests for the native folder picker.

The dialog itself cannot be opened in a test run, so the subprocess call is
stubbed and what is asserted is the contract around it: what a cancel looks
like, what a failure looks like, and that a path is never pasted into the
AppleScript where a quote in a folder name could rewrite it.
"""

import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

from goosequill.services import folder_picker


def _completed(returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


class FolderPickerAvailabilityTests(unittest.TestCase):
    def test_macos_needs_osascript(self):
        with mock.patch.object(folder_picker.sys, "platform", "darwin"):
            with mock.patch.object(folder_picker, "_which", return_value=True):
                self.assertTrue(folder_picker.is_available())
            with mock.patch.object(folder_picker, "_which", return_value=False):
                self.assertFalse(folder_picker.is_available())

    def test_a_platform_with_no_dialog_says_so_rather_than_failing_later(self):
        with mock.patch.object(folder_picker.sys, "platform", "sunos5"):
            with mock.patch.object(folder_picker, "_which", return_value=False):
                self.assertFalse(folder_picker.is_available())
                with self.assertRaises(folder_picker.PickerUnavailableError):
                    folder_picker.choose_folder()


@unittest.skipUnless(sys.platform == "darwin", "macOS dialog behaviour")
class MacOSPickerTests(unittest.TestCase):
    def test_a_chosen_folder_comes_back_as_a_plain_path(self):
        with mock.patch.object(folder_picker, "_run", return_value=_completed(stdout="/srv/example-workspace/\n")) as run:
            self.assertEqual(folder_picker.choose_folder(), "/srv/example-workspace/")
        self.assertEqual(run.call_args.args[0][0], "osascript")

    def test_cancelling_is_not_an_error(self):
        cancelled = _completed(returncode=1, stderr="execution error: User canceled. (-128)")
        with mock.patch.object(folder_picker, "_run", return_value=cancelled):
            self.assertIsNone(folder_picker.choose_folder())

    def test_a_real_failure_is_raised_rather_than_read_as_a_cancel(self):
        broken = _completed(returncode=1, stderr="execution error: something went wrong (-1728)")
        with mock.patch.object(folder_picker, "_run", return_value=broken):
            with self.assertRaises(RuntimeError):
                folder_picker.choose_folder()

    def test_the_start_path_is_passed_as_an_argument_not_pasted_into_the_script(self):
        """A folder named with a quote must not be able to rewrite the AppleScript."""
        nasty = Path('/tmp/eh" & (do shell script "id") & "')
        with mock.patch.object(folder_picker, "_run", return_value=_completed(stdout="/tmp\n")) as run:
            with mock.patch.object(Path, "is_dir", return_value=True):
                folder_picker.choose_folder(start_dir=nasty)
        argv = run.call_args.args[0]
        stdin = run.call_args.kwargs["stdin"]
        self.assertIn(str(nasty), argv)
        self.assertNotIn(str(nasty), stdin)

    def test_a_dialog_killed_under_us_reads_as_a_cancel(self):
        """Killed by a signal (the app shutting down, say) is not a fault."""
        killed = _completed(returncode=-15, stderr="")
        with mock.patch.object(folder_picker, "_run", return_value=killed):
            self.assertIsNone(folder_picker.choose_folder())

    def test_a_start_folder_that_no_longer_exists_is_dropped(self):
        """A missing default location makes the dialog fail rather than fall back."""
        with mock.patch.object(folder_picker, "_run", return_value=_completed(stdout="/tmp\n")) as run:
            folder_picker.choose_folder(start_dir=Path("/nowhere/at/all"))
        self.assertEqual(run.call_args.args[0][2], "")


if __name__ == "__main__":
    unittest.main()
