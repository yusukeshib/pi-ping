"""Real Pi lifecycle smoke test: two deterministic calls, no external models."""
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parent.parent


def main():
    with tempfile.TemporaryDirectory(prefix="pi-ping-smoke-") as directory:
        env = {**os.environ, "PI_CODING_AGENT_DIR": directory, "PI_OFFLINE": "1"}
        Path(directory, "settings.json").write_text(json.dumps({
            "retry": {"enabled": False}, "compaction": {"enabled": False},
        }))
        with open(Path(directory, "stderr.log"), "w+") as stderr:
            child = subprocess.Popen([
                "pi", "--mode", "rpc", "--no-session", "--offline",
                "--no-extensions", "--no-skills", "--no-context-files",
                "--no-prompt-templates", "--no-tools",
                "-e", str(ROOT / "extensions/index.ts"),
                "-e", str(ROOT / "tests/fixtures/provider.js"),
                "--model", "ping-test/local", "--thinking", "off",
            ], cwd=directory, env=env, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=stderr)
            events = queue.Queue()
            records = []

            def read():
                for line in child.stdout:
                    try:
                        events.put(json.loads(line))
                    except Exception as error:
                        events.put({"type": "reader_error", "error": str(error)})
                events.put({"type": "eof"})

            threading.Thread(target=read, daemon=True).start()

            def wait(predicate, timeout=15):
                deadline = time.monotonic() + timeout
                while True:
                    event = events.get(timeout=max(0.001, deadline - time.monotonic()))
                    records.append(event)
                    assert event["type"] not in ("extension_error", "reader_error", "eof"), event
                    if predicate(event):
                        return event
                    assert time.monotonic() < deadline, records[-5:]

            def command(kind, **values):
                identifier = str(len(records))
                child.stdin.write((json.dumps({"id": identifier, "type": kind, **values}) + "\n").encode())
                child.stdin.flush()
                result = wait(lambda e: e.get("type") == "response" and e.get("id") == identifier)
                assert result["success"], result
                return result.get("data")

            try:
                commands = command("get_commands")["commands"]
                assert any(c["name"] == "ping" for c in commands)
                command("prompt", message="Finish the authorized test task.")
                wait(lambda e: e["type"] == "agent_settled")
                assert any(e.get("message", {}).get("errorMessage") == "Simulated network offline" for e in records)
                command("prompt", message="/ping enable 1s")
                wait(lambda e: e["type"] == "agent_settled")
                command("prompt", message="/ping disable")
                messages = command("get_messages")["messages"]
                assert sum(m.get("customType") == "pi-ping" for m in messages) == 1, messages
                assert any(m.get("role") == "assistant" and m.get("stopReason") == "stop" for m in messages), messages
                # Observe a complete interval after disable: any new run is a failure.
                try:
                    wait(lambda e: e["type"] == "agent_start", timeout=1.3)
                    raise AssertionError("Pi woke up after disable")
                except queue.Empty:
                    pass
                command("new_session")
                command("prompt", message="/ping status")
                assert any(e.get("method") == "notify" and "pi-ping disabled" in e.get("message", "") for e in records)
                state = command("get_state")
                assert state["pendingMessageCount"] == 0
                print("PASS: real Pi loads /ping, wakes after simulated offline failure, completes, disables, and resets on new session (2 local calls, 0 external calls).")
            except BaseException:
                stderr.flush()
                stderr.seek(0)
                print(stderr.read())
                print(json.dumps(records[-8:], indent=2))
                raise
            finally:
                child.stdin.close()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


if __name__ == "__main__":
    main()
