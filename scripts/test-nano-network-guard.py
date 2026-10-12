"""Exercise the Nano network guard in fresh processes without models or audio.

Run with the Nano lab Python. Tests use real socket audit events against local
addresses only; no connection, DNS lookup or bind is permitted by the guard.
"""

import argparse
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import sys


REPO = Path(__file__).resolve().parent.parent
CASES = (
    "known_urllib3_probe", "unknown_loopback_bind", "same_name_unknown_caller",
    "known_caller_wrong_address", "connect", "dns",
)


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def expect_blocked(action, event):
    try:
        action()
    except RuntimeError as error:
        require(str(error) == "Offline probe blocked network event: " + event,
                "Unexpected guard exception")
    else:
        raise AssertionError("Expected the real socket event to be denied: " + event)


def run_case(case):
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(
        "nano_probe_guard_test", REPO / "scripts/probe-chatterbox-nano.py")
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    report = {"network": {"blocked_attempts": 0, "python_socket_guard_active": False}}
    probe.prohibit_python_network(report)
    network = report["network"]

    if case in ("known_urllib3_probe", "known_caller_wrong_address"):
        require(socket.has_ipv6, "This Windows Nano test requires Python IPv6 socket support")
        from urllib3.util import connection
        require(network["blocked_attempts"] == 0, "Import tried an unexpected network event")
        require(network["blocked_local_capability_probes"] >= 1,
                "Did not observe the real urllib3 import capability probe")
        before = network["blocked_local_capability_probes"]
        if case == "known_urllib3_probe":
            require(connection._has_ipv6("::1") is False,
                    "Known bind should remain blocked, making urllib3 report no IPv6")
            require(network["blocked_local_capability_probes"] == before + 1,
                    "Known blocked probe was not counted separately")
            require(network["blocked_attempts"] == 0, "Known local probe became a network violation")
            require(network["last_blocked_local_capability_probe"]["allowed"] is False,
                    "Known probe must never be allowed")
        else:
            require(connection._has_ipv6("::") is False, "Wildcard bind should be denied")
            require(network["blocked_attempts"] == 1, "Wrong address bypassed ordinary failure count")
            require(network["blocked_local_capability_probes"] == before,
                    "Wrong address was misclassified as the known probe")
    elif case == "unknown_loopback_bind":
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as sock:
            expect_blocked(lambda: sock.bind(("::1", 0)), "socket.bind")
    elif case == "same_name_unknown_caller":
        def _has_ipv6(host):
            with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as sock:
                sock.bind((host, 0))
        expect_blocked(lambda: _has_ipv6("::1"), "socket.bind")
    elif case == "connect":
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as sock:
            expect_blocked(lambda: sock.connect(("::1", 9)), "socket.connect")
    elif case == "dns":
        expect_blocked(lambda: socket.getaddrinfo("localhost", 443), "socket.getaddrinfo")
    else:
        raise ValueError("Unknown case")

    if case not in ("known_urllib3_probe", "known_caller_wrong_address"):
        require(network["blocked_attempts"] == 1, "Expected exactly one blocked unknown event")
        require(network["blocked_local_capability_probes"] == 0,
                "Unknown caller was misclassified as a known capability probe")
    require(network["python_socket_guard_active"] is True, "Guard is not active")
    print(json.dumps({"case": case, "status": "passed", "network": network}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=CASES)
    args = parser.parse_args()
    if args.case:
        run_case(args.case)
        return 0

    results = []
    for case in CASES:
        try:
            child = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--case", case],
                                   cwd=REPO, text=True, encoding="utf-8", errors="replace",
                                   capture_output=True, timeout=45, check=False)
            require(child.returncode == 0,
                    "Child failed: " + (child.stderr or child.stdout)[-1800:])
            result = json.loads(child.stdout)
            require(result.get("case") == case and result.get("status") == "passed",
                    "Unexpected child result")
            results.append(result)
        except Exception as error:
            results.append({"case": case, "status": "failed", "error": str(error)})
    passed = all(result["status"] == "passed" for result in results)
    print(json.dumps({"status": "passed" if passed else "failed", "passed": sum(
        result["status"] == "passed" for result in results), "total": len(CASES),
        "scope": "FRESH_PROCESS_REAL_SOCKET_EVENTS_NO_MODELS_NO_AUDIO", "cases": results}, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
