"""Unit tests for the platform-specific parts of play_in_mpv_host.py.

Run from the repo root:  python -m unittest discover -s tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import play_in_mpv_host as host  # noqa: E402

MSG = {
    "url": "https://example.com/live.m3u8",
    "title": "My Stream",
    "referrer": "https://example.com/watch",
    "userAgent": "TestAgent/1.0",
    "origin": "https://example.com",
}


class MpvExecutableTest(unittest.TestCase):
    def test_uses_mpv_path_env_var(self):
        path = r"C:\Tools\mpv\mpv.exe"
        self.assertEqual(host.mpv_executable({"MPV_PATH": path}), path)

    def test_mpv_path_wins_over_which(self):
        result = host.mpv_executable({"MPV_PATH": "/x/mpv"}, "linux", lambda n: "/usr/bin/mpv")
        self.assertEqual(result, "/x/mpv")

    def test_uses_which_result(self):
        result = host.mpv_executable({}, "linux", lambda n: "/usr/bin/mpv")
        self.assertEqual(result, "/usr/bin/mpv")

    def test_empty_mpv_path_falls_back(self):
        result = host.mpv_executable({"MPV_PATH": ""}, "linux", lambda n: None, lambda p: False)
        self.assertEqual(result, "mpv")

    def test_windows_finds_scoop_app_dir(self):
        env = {"USERPROFILE": r"C:\Users\me"}
        app = r"C:\Users\me\scoop\apps\mpv\current\mpv.exe"
        result = host.mpv_executable(env, "win32", lambda n: None, lambda p: p == app)
        self.assertEqual(result, app)

    def test_windows_scoop_app_dir_preferred_over_shim(self):
        env = {"USERPROFILE": r"C:\Users\me"}
        app = r"C:\Users\me\scoop\apps\mpv\current\mpv.exe"
        result = host.mpv_executable(env, "win32", lambda n: None, lambda p: True)
        self.assertEqual(result, app)

    def test_windows_falls_back_to_scoop_shim(self):
        env = {"USERPROFILE": r"C:\Users\me"}
        shim = r"C:\Users\me\scoop\shims\mpv.exe"
        result = host.mpv_executable(env, "win32", lambda n: None, lambda p: p == shim)
        self.assertEqual(result, shim)

    def test_windows_honors_scoop_env_var(self):
        env = {"USERPROFILE": r"C:\Users\me", "SCOOP": r"D:\scoop"}
        app = r"D:\scoop\apps\mpv\current\mpv.exe"
        result = host.mpv_executable(env, "win32", lambda n: None, lambda p: p == app)
        self.assertEqual(result, app)

    def test_windows_nothing_found_returns_bare_mpv(self):
        env = {"USERPROFILE": r"C:\Users\me"}
        result = host.mpv_executable(env, "win32", lambda n: None, lambda p: False)
        self.assertEqual(result, "mpv")

    def test_non_windows_skips_scoop_lookup(self):
        env = {"USERPROFILE": r"C:\Users\me"}
        result = host.mpv_executable(env, "linux", lambda n: None, lambda p: True)
        self.assertEqual(result, "mpv")

    def test_macos_finds_homebrew_apple_silicon(self):
        path = "/opt/homebrew/bin/mpv"
        result = host.mpv_executable({}, "darwin", lambda n: None, lambda p: p == path)
        self.assertEqual(result, path)

    def test_macos_finds_homebrew_intel(self):
        path = "/usr/local/bin/mpv"
        result = host.mpv_executable({}, "darwin", lambda n: None, lambda p: p == path)
        self.assertEqual(result, path)

    def test_macos_finds_app_bundle(self):
        path = "/Applications/mpv.app/Contents/MacOS/mpv"
        result = host.mpv_executable({}, "darwin", lambda n: None, lambda p: p == path)
        self.assertEqual(result, path)

    def test_macos_prefers_apple_silicon_homebrew(self):
        result = host.mpv_executable({}, "darwin", lambda n: None, lambda p: True)
        self.assertEqual(result, "/opt/homebrew/bin/mpv")

    def test_macos_which_wins_over_fallbacks(self):
        result = host.mpv_executable({}, "darwin", lambda n: "/custom/bin/mpv", lambda p: True)
        self.assertEqual(result, "/custom/bin/mpv")

    def test_macos_mpv_path_wins_over_fallbacks(self):
        result = host.mpv_executable({"MPV_PATH": "/x/mpv"}, "darwin", lambda n: None, lambda p: True)
        self.assertEqual(result, "/x/mpv")

    def test_macos_nothing_found_returns_bare_mpv(self):
        result = host.mpv_executable({}, "darwin", lambda n: None, lambda p: False)
        self.assertEqual(result, "mpv")

    def test_macos_skips_scoop_lookup(self):
        env = {"USERPROFILE": "/Users/me"}
        checked = []
        host.mpv_executable(env, "darwin", lambda n: None, lambda p: checked.append(p) or False)
        self.assertFalse(any("scoop" in p for p in checked))

    def test_linux_skips_macos_lookup(self):
        checked = []
        result = host.mpv_executable({}, "linux", lambda n: None, lambda p: checked.append(p) or True)
        self.assertEqual(result, "mpv")
        self.assertEqual(checked, [])

    def test_windows_skips_macos_lookup(self):
        env = {"USERPROFILE": r"C:\Users\me"}
        checked = []
        host.mpv_executable(env, "win32", lambda n: None, lambda p: checked.append(p) or False)
        self.assertFalse(any(p.startswith(("/opt/", "/usr/", "/Applications/")) for p in checked))


class BuildCommandTest(unittest.TestCase):
    def test_executable_is_first_arg(self):
        cmd = host.build_command(MSG, r"C:\Tools\mpv\mpv.exe")
        self.assertEqual(cmd[0], r"C:\Tools\mpv\mpv.exe")

    def test_hwdec_auto_safe(self):
        cmd = host.build_command(MSG, "mpv")
        self.assertIn("--hwdec=auto-safe", cmd)
        self.assertFalse(any(a.startswith("--hwdec=") and a != "--hwdec=auto-safe" for a in cmd))

    def test_status_line_suppressed(self):
        self.assertIn("--msg-level=statusline=no", host.build_command(MSG, "mpv"))

    def test_url_is_last_arg(self):
        self.assertEqual(host.build_command(MSG, "mpv")[-1], MSG["url"])

    def test_passes_stream_metadata(self):
        cmd = host.build_command(MSG, "mpv")
        self.assertIn("--force-media-title=My Stream", cmd)
        self.assertIn("--referrer=https://example.com/watch", cmd)
        self.assertIn("--user-agent=TestAgent/1.0", cmd)
        self.assertIn("--http-header-fields=Origin: https://example.com", cmd)

    def test_optional_fields_omitted(self):
        cmd = host.build_command({"url": MSG["url"]}, "mpv")
        self.assertIn("--force-media-title=Stream", cmd)
        self.assertFalse(any(a.startswith(("--referrer=", "--user-agent=", "--http-header-fields=")) for a in cmd))

    def test_reload_script_path(self):
        expected = os.path.join(os.path.dirname(os.path.realpath(host.__file__)), "mpv", "reload.lua")
        self.assertIn("--script=" + expected, host.build_command(MSG, "mpv"))


class PopenKwargsTest(unittest.TestCase):
    def test_windows_breaks_away_from_job(self):
        kwargs = host.popen_kwargs("win32")
        self.assertEqual(kwargs, {"creationflags": 0x01000000 | 0x00000200})
        self.assertNotIn("start_new_session", kwargs)

    def test_windows_flags_match_subprocess_constants(self):
        if sys.platform != "win32":
            self.skipTest("subprocess Windows constants only exist on Windows")
        import subprocess
        expected = subprocess.CREATE_BREAKAWAY_FROM_JOB | subprocess.CREATE_NEW_PROCESS_GROUP
        self.assertEqual(host.popen_kwargs("win32")["creationflags"], expected)

    def test_linux_new_session(self):
        self.assertEqual(host.popen_kwargs("linux"), {"start_new_session": True})

    def test_macos_new_session(self):
        self.assertEqual(host.popen_kwargs("darwin"), {"start_new_session": True})


if __name__ == "__main__":
    unittest.main()
