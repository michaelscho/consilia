"""
Generate BGE-M3 embeddings for all consilia and save as SafeTensors.

Usage:
    python src/embed_consilia.py
    python src/embed_consilia.py --input output/consilia.json --output output/embeddings.safetensors

Each consilium is represented by its title + summary + body sections joined into one
passage.  BGE-M3 (1024-dim, multilingual, 8192-token context) is used so that
queries in Latin, German, or English all map to the same vector space.
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

import numpy as np
from safetensors.numpy import save_file
from sentence_transformers import SentenceTransformer

log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

MODEL_ID = "BAAI/bge-m3"


def consilium_text(c: dict) -> str:
    parts = [c.get("title", "")]
    if c.get("summary"):
        parts.append(c["summary"])
    parts.extend(c.get("body") or [])
    return " ".join(p for p in parts if p)


def embed(
    input_path: str | Path = "output/consilia.json",
    output_path: str | Path = "output/embeddings.safetensors",
    meta_path: str | Path = "output/embeddings_meta.json",
    batch_size: int = 16,
    device: str | None = None,
    fp16: bool = False,
    max_seq_length: int = 512,
) -> None:
    """Generate embeddings for all consilia in *input_path* and save to *output_path*."""
    data = json.loads(Path(input_path).read_text(encoding="utf-8"))
    consilia = list(data["consilia"].values())
    consilia.sort(key=lambda c: c["id"])

    ids = [c["id"] for c in consilia]
    texts = [consilium_text(c) for c in consilia]

    log.info("Loading %s …", MODEL_ID)
    model = SentenceTransformer(MODEL_ID, device=device)
    model.max_seq_length = max_seq_length
    if fp16:
        model.half()
        log.info("Using fp16 (halved GPU memory).")
    log.info("Device: %s  |  max_seq_length: %d", model.device, model.max_seq_length)

    log.info("Embedding %d consilia (batch_size=%d) …", len(texts), batch_size)
    embeddings = model.encode(
        texts,
        batch_size=batch_size,
        show_progress_bar=True,
        normalize_embeddings=True,
        convert_to_numpy=True,
    )
    embeddings = embeddings.astype(np.float32)
    log.info("Embedding shape: %s", embeddings.shape)

    out = Path(output_path)
    save_file({"embeddings": embeddings}, out)
    log.info("Saved %s (%.1f MB)", out, out.stat().st_size / 1e6)

    meta = {
        "model": MODEL_ID,
        "dims": int(embeddings.shape[1]),
        "n": int(embeddings.shape[0]),
        "ids": ids,
        "ns": [c.get("n", 0) for c in consilia],
        "titles": [c.get("title", "") for c in consilia],
    }
    Path(meta_path).write_text(json.dumps(meta), encoding="utf-8")
    log.info("Saved %s", meta_path)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input",  default="output/consilia.json")
    ap.add_argument("--output", default="output/embeddings.safetensors")
    ap.add_argument("--meta",   default="output/embeddings_meta.json")
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--device", default=None,
                    help="Force device: 'cuda', 'cpu', 'cuda:0', etc.")
    ap.add_argument("--fp16", action="store_true",
                    help="Load model in float16 — halves GPU memory (~1 GB vs ~2 GB).")
    ap.add_argument("--max-seq-length", type=int, default=512,
                    help="Token budget per text (default 512). "
                         "BGE-M3 supports up to 8192 but 512 captures the key "
                         "semantic content and runs ~16x faster on CPU.")
    args = ap.parse_args()
    embed(
        input_path=args.input,
        output_path=args.output,
        meta_path=args.meta,
        batch_size=args.batch_size,
        device=args.device,
        fp16=args.fp16,
        max_seq_length=args.max_seq_length,
    )


if __name__ == "__main__":
    main()
