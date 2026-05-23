"""
MCP server for the Consilia corpus.

Exposes two tools to Claude Desktop and Claude Code:
  search_consilia(query, top_k, author_viaf) — semantic search using BGE-M3
  get_consilium(consilium_id)                — return full text of a consilium

Embedding mode (controlled by environment variables):

  Default — HuggingFace Serverless API (no local model needed, no download):
    Each query is sent to api-inference.huggingface.co/models/BAAI/bge-m3.
    Set HF_TOKEN to a HuggingFace token to raise the free-tier rate limit.

  Local model — set CONSILIA_LOCAL_MODEL=1:
    Loads BAAI/bge-m3 (~2 GB) via sentence-transformers on startup (~7 s GPU).
    Fully offline after the first download. Recommended for heavy use.

Claude Desktop / Claude Code config:
  {
    "command": "/path/to/Consilia/.venv/bin/python",
    "args":    ["/path/to/Consilia/src/mcp_server.py"],
    "cwd":     "/path/to/Consilia",
    "env": {
      "HF_TOKEN": "hf_…"          (optional — omit for anonymous free tier)
    }
  }
  Add "CONSILIA_LOCAL_MODEL": "1" to env to use the local model instead.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from pathlib import Path

import httpx
import numpy as np
from mcp.server.fastmcp import FastMCP
from safetensors.numpy import load_file

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s", stream=sys.stderr)
log = logging.getLogger(__name__)

ROOT = Path(__file__).parent.parent
HF_TOKEN          = os.environ.get("HF_TOKEN", "")
USE_LOCAL_MODEL   = os.environ.get("CONSILIA_LOCAL_MODEL", "").strip() == "1"
HF_API_URL        = "https://api-inference.huggingface.co/models/BAAI/bge-m3"

# ---------------------------------------------------------------------------
# Load corpus data at startup (always)
# ---------------------------------------------------------------------------

log.info("Loading consilia.json …")
_data = json.loads((ROOT / "output" / "consilia.json").read_text(encoding="utf-8"))
CONSILIA: dict[str, dict] = _data["consilia"]

log.info("Loading embeddings …")
_tensors = load_file(str(ROOT / "output" / "embeddings.safetensors"))
EMBEDDINGS: np.ndarray = _tensors["embeddings"].astype(np.float32)

_meta = json.loads((ROOT / "output" / "embeddings_meta.json").read_text(encoding="utf-8"))
META_IDS: list[str]   = _meta["ids"]
META_VIAFS: list[str] = _meta.get("author_viafs", [""] * len(META_IDS))

# ---------------------------------------------------------------------------
# Embedding backend
# ---------------------------------------------------------------------------

if USE_LOCAL_MODEL:
    from sentence_transformers import SentenceTransformer
    log.info("Loading BGE-M3 model locally (CONSILIA_LOCAL_MODEL=1) …")
    _model = SentenceTransformer("BAAI/bge-m3")
    _model.max_seq_length = 512
    log.info("Local model ready.")

    def _embed(text: str) -> np.ndarray:
        vec = _model.encode([text], normalize_embeddings=True)[0].astype(np.float32)
        return vec

else:
    log.info("Using HuggingFace Serverless API for embeddings%s.",
             " (authenticated)" if HF_TOKEN else " (anonymous — set HF_TOKEN to raise rate limits)")

    def _embed(text: str) -> np.ndarray:
        headers = {"Authorization": f"Bearer {HF_TOKEN}"} if HF_TOKEN else {}
        for attempt in range(3):
            r = httpx.post(HF_API_URL, json={"inputs": text}, headers=headers, timeout=30.0)
            if r.status_code == 503:
                wait = r.json().get("estimated_time", 20)
                log.info("Model loading on HF side, waiting %.0f s …", wait)
                time.sleep(wait)
                continue
            r.raise_for_status()
            raw = r.json()
            # Response is [[f0…f1023]] — unwrap batch dimension
            while isinstance(raw, list) and isinstance(raw[0], list):
                raw = raw[0]
            vec = np.array(raw, dtype=np.float32)
            norm = float(np.linalg.norm(vec))
            if norm > 0:
                vec /= norm
            return vec
        raise RuntimeError("HF API unavailable after 3 attempts.")

log.info("Ready — %d consilia, %d embeddings.", len(CONSILIA), len(META_IDS))

# ---------------------------------------------------------------------------
# MCP server
# ---------------------------------------------------------------------------

mcp = FastMCP("consilia")


@mcp.tool()
def search_consilia(
    query: str,
    top_k: int = 10,
    author_viaf: str | None = None,
) -> list[dict]:
    """Semantic search over the Consilia corpus using BGE-M3 embeddings.

    Queries can be in Latin, German, or English — all map to the same vector
    space.  Returns the top_k most similar consilia ranked by cosine similarity.

    Args:
        query: Search query in any language.
        top_k: Number of results to return (default 10, max 50).
        author_viaf: Optional filter by author directory name (e.g. 'Baldo_29618397').
    """
    top_k = min(max(1, top_k), 50)

    q_vec = _embed(query)
    sims = EMBEDDINGS @ q_vec

    results: list[dict] = []
    for i in np.argsort(-sims):
        if author_viaf and META_VIAFS[i] != author_viaf:
            continue
        cid = META_IDS[i]
        c = CONSILIA.get(cid)
        if c is None:
            continue
        snippet = c.get("summary") or (c.get("body") or [""])[0]
        results.append({
            "id":          cid,
            "n":           c.get("n"),
            "title":       c.get("title", ""),
            "author_viaf": c.get("author_viaf", ""),
            "score":       round(float(sims[i]), 4),
            "snippet":     (snippet or "")[:300],
        })
        if len(results) >= top_k:
            break

    return results


@mcp.tool()
def get_consilium(consilium_id: str) -> dict:
    """Return the complete text of a consilium: title, summary, and all body sections.

    Args:
        consilium_id: The consilium ID, e.g. 'consilium-baldo_cons_print_venice_1575_v1-44'.
                      Use search_consilia() first to find the correct ID.
    """
    c = CONSILIA.get(consilium_id)
    if c is None:
        return {"error": f"Consilium '{consilium_id}' not found."}
    return {
        "id":          c["id"],
        "n":           c.get("n"),
        "roman":       c.get("roman", ""),
        "author_viaf": c.get("author_viaf", ""),
        "volume":      c.get("volume", ""),
        "title":       c.get("title", ""),
        "summary":     c.get("summary", ""),
        "body":        c.get("body", []),
    }


if __name__ == "__main__":
    mcp.run()
