#!/usr/bin/env python3
import argparse
import json
import pathlib
import urllib.request


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact_json")
    parser.add_argument(
        "--url",
        default="http://127.0.0.1:3000/api/finance/imports",
    )
    args = parser.parse_args()

    artifact_path = pathlib.Path(args.artifact_json).expanduser().resolve()
    payload = artifact_path.read_text(encoding="utf-8").encode("utf-8")
    request = urllib.request.Request(
        args.url,
        data=payload,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        body = response.read().decode("utf-8")
        print(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
