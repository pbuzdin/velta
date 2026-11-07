"""The package gate must inspect requirements, compare numerically and fail closed."""
import contextlib
import importlib.util
import io
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "check_glibc", Path(__file__).resolve().parents[1] / "tools/check-glibc.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class GlibcGateTest(unittest.TestCase):
    def test_parse_only_requirements(self):
        info = """Version definition section '.gnu.version_d'
  Name: GLIBC_2.99
Version needs section '.gnu.version_r'
  Name: GLIBC_2.9  Flags: none
  Name: GLIBC_2.36  Flags: none
  Name: GCC_4.2.0  Flags: none
"""
        self.assertEqual(gate.required_versions(info), [(2, 9), (2, 36)])
        self.assertEqual(gate.required_versions("No version information found"), [])

    def test_all_elf_files_including_nonexecutables_and_appimage_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "payload").mkdir()
            (root / "payload" / "library.so").write_bytes(b"\x7fELFfixture")
            (root / "payload" / "readme").write_text("not an ELF")
            runtime = root / "app.AppImage"
            runtime.write_bytes(b"\x7fELFfixture")
            for required, status in [("2.9", 0), ("2.36", 0), ("2.38", 1), ("2.100", 1)]:
                info = f"Version needs section\n Name: GLIBC_{required}\n"
                with patch.object(gate.subprocess, "check_output", return_value=info) as readelf:
                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(gate.check((2, 36), [root / "payload", runtime]), status)
                    self.assertEqual(readelf.call_count, 2)

    def test_real_elf_and_missing_or_empty_input(self):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(gate.check((999,), [shutil.which("true")]), 0)
            self.assertEqual(gate.check((0,), [shutil.which("true")]), 1)
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                gate.check((2, 36), [directory])
            with self.assertRaises(FileNotFoundError):
                gate.check((2, 36), [Path(directory) / "missing"])
            broken = Path(directory) / "broken.so"
            broken.write_bytes(b"\x7fELFbroken")
            with self.assertRaises(gate.subprocess.CalledProcessError):
                gate.check((2, 36), [broken])


if __name__ == "__main__":
    unittest.main()
