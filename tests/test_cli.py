import sys
import unittest
import subprocess
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

class TestCLI(unittest.TestCase):
    """Unit tests for unified cli.py entrypoint."""

    def test_cli_help(self):
        """Verify cli.py --help returns exit code 0."""
        res = subprocess.run(
            [sys.executable, str(PROJECT_ROOT / "cli.py"), "--help"],
            capture_output=True,
            text=True
        )
        self.assertEqual(res.returncode, 0)
        self.assertIn("convert", res.stdout)
        self.assertIn("combine", res.stdout)
        self.assertIn("serve", res.stdout)

    def test_cli_convert_help(self):
        """Verify cli.py convert --help returns exit code 0."""
        res = subprocess.run(
            [sys.executable, str(PROJECT_ROOT / "cli.py"), "convert", "--help"],
            capture_output=True,
            text=True
        )
        self.assertEqual(res.returncode, 0)
        self.assertIn("--model", res.stdout)

    def test_cli_combine_help(self):
        """Verify cli.py combine --help returns exit code 0."""
        res = subprocess.run(
            [sys.executable, str(PROJECT_ROOT / "cli.py"), "combine", "--help"],
            capture_output=True,
            text=True
        )
        self.assertEqual(res.returncode, 0)
        self.assertIn("--folder", res.stdout)

if __name__ == "__main__":
    unittest.main()
