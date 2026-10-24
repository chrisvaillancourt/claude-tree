"""Drive an interactive Claude Code session in a pty and snapshot the screen.

Run with uv (pyte is the only dependency):

    uv run --with pyte python scripts/drive.py --cwd DIR --out PREFIX \
        --plugin-dir . step [step ...]

Steps, run in order:
    say:TEXT        type TEXT and press Enter
    type:TEXT       type TEXT, no Enter
    key:NAME        press a key: enter esc tab up down left right backspace, or one character
    wait:SECS       pump output for SECS seconds
    waitfor:REGEX   wait (up to --timeout) until a screen line matches REGEX
    quiet:SECS      wait until the screen has been still for SECS seconds
    snap:NAME       write the screen to PREFIX.NAME.txt

Answers the folder trust dialog at startup (it defaults to "No, exit"). Child sessions inherit
CLAUDE_CODE_CHILD_SESSION, which turns transcript saving off; the driver
sets CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 so the session has a transcript.
"""
import argparse
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

import pyte

KEYS = {
    "enter": "\r", "esc": "\x1b", "tab": "\t", "backspace": "\x7f",
    "up": "\x1b[A", "down": "\x1b[B", "right": "\x1b[C", "left": "\x1b[D",
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cwd", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="haiku")
    ap.add_argument("--plugin-dir", action="append", default=[])
    ap.add_argument("--allowed-tools", default="Bash(echo:*)")
    ap.add_argument("--arg", action="append", default=[], help="extra claude argument")
    ap.add_argument("--cols", type=int, default=180)
    ap.add_argument("--rows", type=int, default=60)
    ap.add_argument("--timeout", type=float, default=120)
    ap.add_argument("steps", nargs="*")
    a = ap.parse_args()

    argv = ["claude", "--model", a.model, "--allowedTools", a.allowed_tools, *a.arg]
    for d in a.plugin_dir:
        argv += ["--plugin-dir", d]

    env = dict(os.environ)
    for k in ("CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT"):
        env.pop(k, None)
    env["CLAUDE_CODE_FORCE_SESSION_PERSISTENCE"] = "1"
    env["TERM"] = "xterm-256color"
    env["COLUMNS"], env["LINES"] = str(a.cols), str(a.rows)

    screen = pyte.Screen(a.cols, a.rows)
    stream = pyte.ByteStream(screen)
    size = struct.pack("HHHH", a.rows, a.cols, 0, 0)

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(a.cwd)
        fcntl.ioctl(0, termios.TIOCSWINSZ, size)
        os.execvpe(argv[0], argv, env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, size)

    start = time.time()
    last = [time.time()]

    def pump(secs: float) -> None:
        end = time.time() + secs
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if not r:
                continue
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            if not data:
                return
            stream.feed(data)
            last[0] = time.time()

    def text() -> str:
        return "\n".join(line.rstrip() for line in screen.display)

    def snap(name: str) -> None:
        with open(f"{a.out}.{name}.txt", "w") as f:
            f.write(text() + "\n")

    def send(s: str) -> None:
        os.write(fd, s.encode())
        pump(0.15)

    def until(pred, secs: float) -> bool:
        end = time.time() + secs
        while time.time() < end:
            pump(0.2)
            if pred():
                return True
        return False

    until(lambda: time.time() - last[0] > 2.5, 40)
    if "trust" in text().lower() and "folder" in text().lower():
        snap("trust")
        send(KEYS["down"])  # the dialog defaults to "No, exit"
        send("\r")
        until(lambda: time.time() - last[0] > 2.5, 30)
    snap("ready")

    ok = True
    for step in a.steps:
        kind, _, arg = step.partition(":")
        if kind == "say":
            for ch in arg:
                send(ch)
            pump(0.3)
            send("\r")
        elif kind == "type":
            for ch in arg:
                send(ch)
        elif kind == "key":
            send(KEYS.get(arg, arg))
        elif kind == "wait":
            pump(float(arg))
        elif kind == "quiet":
            until(lambda: time.time() - last[0] > float(arg), a.timeout)
        elif kind == "waitfor":
            rx = re.compile(arg)
            if not until(lambda: any(rx.search(line) for line in screen.display), a.timeout):
                print(f"timeout waiting for {arg!r}", file=sys.stderr)
                snap("timeout")
                ok = False
                break
        elif kind == "snap":
            snap(arg)
        else:
            print(f"unknown step {step!r}", file=sys.stderr)

    os.kill(pid, signal.SIGTERM)
    pump(1.0)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    print(f"{'ok' if ok else 'FAILED'} in {time.time() - start:.0f}s")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
