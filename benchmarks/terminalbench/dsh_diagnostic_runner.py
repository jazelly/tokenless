"""Run DSH while retaining only allowlisted error categories, never its output."""

import json
import re
import subprocess
import sys


def main() -> None:
    patterns = {
        "timeout": rb"TimeoutError|timed out|timeout exceeded|ETIMEDOUT",
        "aborted": rb"AbortError|operation was aborted",
        "connection": rb"ECONNRESET|ECONNREFUSED|fetch failed|socket hang up",
        "context_length": rb"context_length_exceeded|maximum context length",
        "invalid_tool_call": rb"InvalidToolInput|invalid tool|tool.*validation failed",
        "invalid_response": rb"JSONParseError|TypeValidationError|invalid JSON|Unexpected token",
        "rate_limit": rb"RateLimitError|rate_limit_exceeded|Too Many Requests",
        "permission": rb"EACCES|Permission denied",
    }
    process = subprocess.Popen(sys.argv[1:], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    observed = set()
    tail = b""
    assert process.stdout is not None
    while chunk := process.stdout.read1(4096):
        window = tail + chunk
        for name, pattern in patterns.items():
            if re.search(pattern, window, re.IGNORECASE):
                observed.add(name)
        tail = window[-1024:]
    code = process.wait()
    print(json.dumps({
        "schema": "tokenless.terminalbench-dsh-diagnostic.v1",
        "classification": "dsh_succeeded" if code == 0 else "dsh_nonzero_exit",
        "exceptionClass": None if code == 0 else "NonZeroAgentExitCodeError",
        "exitCode": code,
        "observedErrorCategories": sorted(observed),
    }))


if __name__ == "__main__":
    main()
