#!/usr/bin/env python3
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
from datetime import datetime, timezone


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_text_from_pdf(path: pathlib.Path) -> str:
    if shutil.which("pdftotext"):
        result = subprocess.run(
            ["pdftotext", str(path), "-"],
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout
    if shutil.which("strings"):
        result = subprocess.run(
            ["strings", "-n", "6", str(path)],
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout
    raise RuntimeError("Neither pdftotext nor strings is available for PDF text extraction.")


def build_schema() -> dict:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "schemaVersion",
            "sourceKind",
            "sourceFile",
            "artifactSha256",
            "extractor",
            "registrySuggestions",
            "documents",
            "transactions",
            "provenance",
        ],
        "properties": {
            "schemaVersion": {"type": "string", "enum": ["finance-source-import.v1"]},
            "sourceKind": {"type": "string", "enum": ["pdf", "statement", "csv", "ofx"]},
            "sourceFile": {"type": "object"},
            "artifactSha256": {"type": "string"},
            "extractor": {"type": "object"},
            "registrySuggestions": {"type": "object"},
            "documents": {"type": "array"},
            "transactions": {"type": "array"},
            "provenance": {"type": "object"},
        },
    }


def build_prompt(path: pathlib.Path, extracted_text: str) -> str:
    return f"""Classify this financial PDF into zmail finance-source-import.v1 JSON.

PDF path: {path}

Rules:
- Return JSON only.
- Be conservative.
- Prefer nulls and empty arrays when evidence is weak.
- Only emit registry suggestions that are likely useful for later reconciliation.
- Extract transactions and statements when clearly present.

Extracted text:
{extracted_text}
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf_path")
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="opus")
    args = parser.parse_args()

    pdf_path = pathlib.Path(args.pdf_path).expanduser().resolve()
    output_path = pathlib.Path(args.output).expanduser().resolve()
    raw_bytes = pdf_path.read_bytes()
    file_sha = sha256_bytes(raw_bytes)
    extracted_text = read_text_from_pdf(pdf_path)
    extracted_text_hash = sha256_bytes(extracted_text.encode("utf-8"))

    prompt = build_prompt(pdf_path, extracted_text)
    command = [
        "claude",
        "-p",
        "--model",
        args.model,
        "--output-format",
        "json",
        "--json-schema",
        json.dumps(build_schema()),
        prompt,
    ]
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    parsed = json.loads(result.stdout)

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    artifact = {
        "schemaVersion": "finance-source-import.v1",
        "sourceKind": parsed.get("sourceKind", "pdf"),
        "sourceFile": {
            "absolutePath": str(pdf_path),
            "sha256": file_sha,
            "filename": pdf_path.name,
            "importedAt": now,
        },
        "artifactSha256": sha256_bytes(result.stdout.encode("utf-8")),
        "extractor": {
            "runner": "claude-cli",
            "model": args.model,
            "promptVersion": "finance-pdf-extract.v1",
            "extractedTextHash": extracted_text_hash,
        },
        "registrySuggestions": parsed.get(
            "registrySuggestions",
            {
                "identities": [],
                "institutions": [],
                "financialAccounts": [],
                "senderRules": [],
            },
        ),
        "documents": parsed.get("documents", []),
        "transactions": parsed.get("transactions", []),
        "provenance": {
            "pdfPath": str(pdf_path),
            "claudeCommand": command[:-1],
        },
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(artifact, indent=2), encoding="utf-8")
    print(str(output_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
