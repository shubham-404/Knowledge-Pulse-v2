"""One interface, two providers.

Groq during development because it is free and fast enough to iterate against;
Gemini for the demo. Nothing outside this module knows which is in use.

Both are called over plain HTTP rather than through vendor SDKs. Two reasons:
the SDKs churn, and a fifty-line HTTP call is easier to reason about in a paper
than a dependency whose behaviour changes between minor versions.
"""

from __future__ import annotations

import json
import logging
import re

import httpx

from app.config import settings

log = logging.getLogger(__name__)


class LLMError(RuntimeError):
    pass


# def _groq(system: str, user: str, temperature: float, max_tokens: int) -> str:
#     if not settings.groq_api_key:
#         raise LLMError("GROQ_API_KEY is not set")
#     r = httpx.post(
#         "https://api.groq.com/openai/v1/chat/completions",
#         headers={"Authorization": f"Bearer {settings.groq_api_key}"},
#         json={
#             "model": settings.groq_model,
#             "messages": [
#                 {"role": "system", "content": system},
#                 {"role": "user", "content": user},
#             ],
#             "temperature": temperature,
#             "max_tokens": max_tokens,
#         },
#         timeout=settings.llm_timeout_seconds,
#     )
#     if r.status_code != 200:
#         raise LLMError(f"Groq returned {r.status_code}: {r.text[:300]}")
#     return r.json()["choices"][0]["message"]["content"]

def _groq(
    system: str,
    user: str,
    temperature: float,
    max_tokens: int,
    json_mode: bool = False,
) -> str:
    if not settings.groq_api_key:
        raise LLMError("GROQ_API_KEY is not set")

    payload = {
        "model": settings.groq_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "reasoning_effort": "low",
    }

    if json_mode:
        payload["response_format"] = {"type": "json_object"}

    r = httpx.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {settings.groq_api_key}"},
        json=payload,
        timeout=settings.llm_timeout_seconds,
    )

    if r.status_code != 200:
        raise LLMError(f"Groq returned {r.status_code}: {r.text[:300]}")

    payload = r.json()

    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError) as exc:
        raise LLMError(
            f"Unexpected Groq response: {json.dumps(payload)[:500]}"
        ) from exc

    if not content:
        raise LLMError(
            f"Groq returned empty content. Response: {json.dumps(payload)[:500]}"
        )

    return content

# def _gemini(system: str, user: str, temperature: float, max_tokens: int) -> str:
    # if not settings.gemini_api_key:
    #     raise LLMError("GEMINI_API_KEY is not set")
    # url = (
    #     f"https://generativelanguage.googleapis.com/v1beta/models/"
    #     f"{settings.gemini_model}:generateContent"
    # )
    # r = httpx.post(
    #     url,
    #     params={"key": settings.gemini_api_key},
    #     json={
    #         "systemInstruction": {"parts": [{"text": system}]},
    #         "contents": [{"role": "user", "parts": [{"text": user}]}],
    #         "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens},
    #     },
    #     timeout=settings.llm_timeout_seconds,
    # )
    # if r.status_code != 200:
    #     raise LLMError(f"Gemini returned {r.status_code}: {r.text[:300]}")
    # payload = r.json()
    # try:
    #     return payload["candidates"][0]["content"]["parts"][0]["text"]
    # except (KeyError, IndexError) as exc:
    #     raise LLMError(f"Unexpected Gemini response: {json.dumps(payload)[:300]}") from exc
# def _gemini(system: str, user: str, temperature: float, max_tokens: int) -> str:
#     if not settings.gemini_api_key:
#         raise LLMError("GEMINI_API_KEY is not set")

#     url = "https://generativelanguage.googleapis.com/v1/interactions"

#     model = settings.gemini_model
#     if not model.startswith("models/"):
#         model = f"models/{model}"

#     r = httpx.post(
#         url,
#         headers={
#             "x-goog-api-key": settings.gemini_api_key,
#             "Content-Type": "application/json",
#         },
#         json={
#             "model": model,
#             "input": user,
#             "system_instruction": system,
#             "store": False,
#             "generation_config": {
#                 "temperature": temperature,
#                 "max_output_tokens": max_tokens,
#                 "thinking_level": "minimal",
#             },
#         },
#         timeout=settings.llm_timeout_seconds,
#     )

#     if r.status_code != 200:
#         raise LLMError(
#             f"Gemini returned {r.status_code}: {r.text[:500]}"
#         )

#     payload = r.json()

#     if payload.get("status") != "completed":
#         raise LLMError(
#             f"Gemini interaction did not complete: "
#             f"{json.dumps(payload)[:500]}"
#         )

#     try:
#         for step in payload["steps"]:
#             if step.get("type") == "model_output":
#                 for content in step.get("content", []):
#                     if content.get("type") == "text":
#                         return content["text"]

#     except (KeyError, TypeError):
#         pass

#     raise LLMError(
#         f"Unexpected Gemini interaction response: "
#         f"{json.dumps(payload)[:500]}"
#     )

def _gemini(
    system: str,
    user: str,
    temperature: float,
    max_tokens: int,
) -> str:
    import time

    if not settings.gemini_api_key:
        raise LLMError("GEMINI_API_KEY is not set")

    url = "https://generativelanguage.googleapis.com/v1/interactions"

    model = settings.gemini_model
    if not model.startswith("models/"):
        model = f"models/{model}"

    headers = {
        "x-goog-api-key": settings.gemini_api_key,
        "Content-Type": "application/json",
    }

    request_body = {
        "model": model,
        "input": user,
        "system_instruction": system,
        "store": False,
        "generation_config": {
            "temperature": temperature,
            "max_output_tokens": max_tokens,
            "thinking_level": "minimal",
        },
    }

    timeout = httpx.Timeout(
        connect=20.0,
        read=180.0,
        write=30.0,
        pool=20.0,
    )

    for attempt in range(3):
        try:
            r = httpx.post(
                url,
                headers=headers,
                json=request_body,
                timeout=timeout,
            )

            if r.status_code in (429, 500, 502, 503, 504):
                if attempt < 2:
                    delay = 2 ** (attempt + 1)
                    log.warning(
                        "Gemini returned %s. Retrying in %ss.",
                        r.status_code,
                        delay,
                    )
                    time.sleep(delay)
                    continue

            if r.status_code != 200:
                raise LLMError(
                    f"Gemini returned {r.status_code}: {r.text[:500]}"
                )

            payload = r.json()

            if payload.get("status") != "completed":
                raise LLMError(
                    "Gemini interaction did not complete: "
                    f"{json.dumps(payload)[:500]}"
                )

            for step in payload.get("steps", []):
                if step.get("type") == "model_output":
                    for content in step.get("content", []):
                        if content.get("type") == "text":
                            result = content.get("text", "")
                            if result.strip():
                                return result

            raise LLMError(
                "Unexpected Gemini interaction response: "
                f"{json.dumps(payload)[:500]}"
            )

        except (
            httpx.TimeoutException,
            httpx.NetworkError,
            httpx.RemoteProtocolError,
        ) as exc:
            if attempt == 2:
                raise LLMError(
                    "Gemini request failed after 3 attempts"
                ) from exc

            delay = 2 ** (attempt + 1)
            log.warning(
                "Gemini request failed (%s). Retrying in %ss.",
                type(exc).__name__,
                delay,
            )
            time.sleep(delay)

    raise LLMError("Gemini failed after 3 attempts")
def complete(
    user: str,
    system: str = "You are a careful assistant. Answer only from what you are given.",
    temperature: float = 0.2,
    max_tokens: int = 900,
) -> str:
    provider = settings.llm_provider.lower()
    if provider == "groq":
        return _groq(system, user, temperature, max_tokens).strip()
    if provider == "gemini":
        return _gemini(system, user, temperature, max_tokens).strip()
    raise LLMError(f"Unknown LLM_PROVIDER: {settings.llm_provider}")


# def complete_json(user: str, system: str, temperature: float = 0.2, max_tokens: int = 900):
#     """Ask for JSON and parse it, tolerating the fenced-code-block habit."""
#     raw = complete(user, system + "\n\nReply with JSON only. No prose, no code fences.",
#                    temperature, max_tokens)
#     cleaned = re.sub(r"^```(?:json)?|```$", "", raw.strip(), flags=re.MULTILINE).strip()
#     try:
#         return json.loads(cleaned)
#     except json.JSONDecodeError:
#         # Last resort: pull the outermost brace or bracket pair.
#         match = re.search(r"[\[{].*[\]}]", cleaned, re.DOTALL)
#         if not match:
#             raise LLMError(f"Model did not return JSON: {cleaned[:200]}")
#         return json.loads(match.group(0))
def complete_json(
    user: str,
    system: str,
    temperature: float = 0.2,
    max_tokens: int = 900,
):
    """Ask for JSON and parse it, tolerating fenced-code-block output."""

    provider = settings.llm_provider.lower()

    if provider == "groq":
        raw = _groq(
            system + "\n\nReply with valid JSON only.",
            user,
            temperature,
            max_tokens,
            json_mode=True,
        ).strip()
    else:
        raw = complete(
            user,
            system + "\n\nReply with JSON only. No prose, no code fences.",
            temperature,
            max_tokens,
        )

    cleaned = re.sub(
        r"^```(?:json)?|```$",
        "",
        raw.strip(),
        flags=re.MULTILINE,
    ).strip()

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"[\[{].*[\]}]", cleaned, re.DOTALL)

        if not match:
            raise LLMError(
                f"Model did not return JSON: {cleaned[:200]}"
            )

        return json.loads(match.group(0))