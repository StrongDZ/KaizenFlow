"""The two independent readers (Claude and Gemini) behind one small interface, with a disk cache.

Every answer is cached under (reader, prompt, schema, image bytes), so a rerun
of autolabel costs nothing and gives the same labels. Transient failures
(rate limit, network, server error) raise TransientError and are not cached;
the image is retried on the next run.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Protocol

DEFAULT_CLAUDE_MODEL = "claude-opus-5-5"
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


class TransientError(Exception):
    """The request may succeed later (rate limit, network, server error)."""


class Reader(Protocol):
    name: str

    def ask(self, image: bytes, prompt: str, schema: dict) -> dict | None:
        """The JSON answer about a JPEG image, or None when the model gives none."""
        ...


def parse_json(text: str) -> dict | None:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`").removeprefix("json").strip()
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


class CachedReader:
    def __init__(self, reader: Reader, cache_dir: Path) -> None:
        self.reader = reader
        self.name = reader.name
        self.dir = cache_dir / reader.name.replace("/", "_")

    def ask(self, image: bytes, prompt: str, schema: dict) -> dict | None:
        h = hashlib.sha256()
        for part in (self.name.encode(), prompt.encode(), json.dumps(schema, sort_keys=True).encode(), image):
            h.update(part)
            h.update(b"\0")
        path = self.dir / f"{h.hexdigest()}.json"
        if path.exists():
            return json.loads(path.read_text())["answer"]
        answer = self.reader.ask(image, prompt, schema)
        self.dir.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"answer": answer}))
        return answer


class ClaudeReader:
    """Claude through the official SDK, with structured output and server-side refusal fallback."""

    def __init__(self, model: str = DEFAULT_CLAUDE_MODEL) -> None:
        import anthropic  # only the labelling run needs it

        self._anthropic = anthropic
        self.client = anthropic.Anthropic(max_retries=4)
        self.model = model
        self.name = model

    def ask(self, image: bytes, prompt: str, schema: dict) -> dict | None:
        a = self._anthropic
        try:
            response = self.client.beta.messages.create(
                model=self.model,
                max_tokens=4096,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                output_config={"effort": "medium", "format": {"type": "json_schema", "schema": schema}},
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/jpeg",
                                    "data": base64.standard_b64encode(image).decode(),
                                },
                            },
                            {"type": "text", "text": prompt},
                        ],
                    }
                ],
            )
        except (a.RateLimitError, a.InternalServerError, a.APIConnectionError) as e:
            raise TransientError(str(e)) from e
        if response.stop_reason in ("refusal", "max_tokens"):
            return None
        return parse_json("".join(b.text for b in response.content if b.type == "text"))


def gemini_schema(schema: dict) -> dict:
    """The JSON schema without the keywords Gemini's responseSchema rejects."""
    out = {}
    for key, value in schema.items():
        if key == "additionalProperties":
            continue
        if key == "properties":
            out[key] = {k: gemini_schema(v) for k, v in value.items()}
        elif key == "items":
            out[key] = gemini_schema(value)
        else:
            out[key] = value
    return out


class GeminiReader:
    """Gemini through its REST API (no extra dependency)."""

    def __init__(self, model: str = DEFAULT_GEMINI_MODEL, api_key: str | None = None, attempts: int = 4) -> None:
        self.api_key = api_key or os.environ.get("GEMINI_API_KEY", "")
        if not self.api_key:
            raise SystemExit("GEMINI_API_KEY is not set")
        self.model = model
        self.name = model
        self.attempts = attempts

    def ask(self, image: bytes, prompt: str, schema: dict) -> dict | None:
        body = {
            "contents": [
                {
                    "parts": [
                        {"inline_data": {"mime_type": "image/jpeg", "data": base64.standard_b64encode(image).decode()}},
                        {"text": prompt},
                    ]
                }
            ],
            "generationConfig": {
                "temperature": 0,
                "responseMimeType": "application/json",
                "responseSchema": gemini_schema(schema),
            },
        }
        request = urllib.request.Request(
            GEMINI_URL.format(model=self.model),
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "x-goog-api-key": self.api_key},
        )
        for attempt in range(self.attempts):
            try:
                with urllib.request.urlopen(request, timeout=120) as response:
                    reply = json.load(response)
                break
            except urllib.error.HTTPError as e:
                if e.code != 429 and e.code < 500:
                    raise RuntimeError(f"Gemini {e.code}: {e.read().decode(errors='replace')[:500]}") from e
                error: Exception = e
            except (urllib.error.URLError, TimeoutError) as e:
                error = e
            if attempt == self.attempts - 1:
                raise TransientError(str(error))
            time.sleep(2 ** (attempt + 1))
        candidates = reply.get("candidates") or []
        if not candidates:
            return None  # blocked by a safety filter
        parts = candidates[0].get("content", {}).get("parts", [])
        return parse_json("".join(p.get("text", "") for p in parts))
