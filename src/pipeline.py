"""
Main pipeline: walk data/ → parse PageXML → segment consilia → write JSON → embed.

Usage:
    python pipeline.py [--no-lb-model] [--volume VOLUME_DIR_NAME] [--no-embed]

Options:
    --no-lb-model   Use heuristic dehyphenation (¬ → merge) instead of Flair.
    --volume NAME   Process only the named volume subdirectory.
    --no-embed      Skip the embedding stage even if embeddings are stale.
    --embed-fp16    Load BGE-M3 in float16 (~1 GB VRAM instead of ~2 GB).
    --embed-device  Force device for embedding: 'cuda', 'cpu', 'cuda:0', etc.

Output:
    output/<volume_name>.json          per-volume consilium dictionary
    output/consilia.json               merged dictionary across all volumes
    output/embeddings.safetensors      BGE-M3 Float32[N, 1024] (when stale)
    output/embeddings_meta.json        embedding metadata
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

# Allow running from src/ or from project root
sys.path.insert(0, str(Path(__file__).parent))

from parse_pagexml import parse_pagexml, PageData
from segment_consilia import ConsiliumSegmenter, iter_lines

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

ROOT = Path(__file__).parent.parent
DATA_DIR = ROOT / "data"
OUTPUT_DIR = ROOT / "output"


# ---------------------------------------------------------------------------
# Volume discovery
# ---------------------------------------------------------------------------


def find_volumes(data_dir: Path) -> list[Path]:
    """Return all subdirectories of data_dir that contain a 'page' folder."""
    return sorted(
        d for d in data_dir.iterdir()
        if d.is_dir() and (d / "page").is_dir()
    )


# ---------------------------------------------------------------------------
# Per-volume processing
# ---------------------------------------------------------------------------


def load_pages(volume_dir: Path) -> list[PageData]:
    page_dir = volume_dir / "page"
    xml_files = sorted(page_dir.glob("*.xml"), key=lambda p: int(p.stem))
    pages: list[PageData] = []
    for xml_file in xml_files:
        try:
            pages.append(parse_pagexml(xml_file))
        except Exception as exc:
            log.warning("Could not parse %s: %s", xml_file.name, exc)
    log.info("  Loaded %d pages from %s", len(pages), volume_dir.name)
    return pages


def process_volume(volume_dir: Path, use_lb_model: bool = True) -> dict:
    """Process one volume and return a dict keyed by consilium id."""
    log.info("Processing volume: %s", volume_dir.name)
    pages = load_pages(volume_dir)

    segmenter = ConsiliumSegmenter(
        volume=volume_dir.name,
        use_lb_model=use_lb_model,
    )
    consilia = segmenter.process(iter_lines(pages))
    log.info("  Extracted %d consilia", len(consilia))

    return {c.id: c.to_dict() for c in consilia}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _embeddings_stale(consilia_path: Path, embeddings_path: Path) -> bool:
    """Return True if embeddings are missing or older than consilia.json."""
    if not embeddings_path.exists():
        return True
    return consilia_path.stat().st_mtime > embeddings_path.stat().st_mtime


def run(
    volume_filter: str | None = None,
    use_lb_model: bool = True,
    embed: bool = True,
    embed_fp16: bool = False,
    embed_device: str | None = None,
) -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)

    volumes = find_volumes(DATA_DIR)
    if not volumes:
        log.error("No volumes found in %s", DATA_DIR)
        sys.exit(1)

    if volume_filter:
        volumes = [v for v in volumes if v.name == volume_filter]
        if not volumes:
            log.error("Volume '%s' not found in %s", volume_filter, DATA_DIR)
            sys.exit(1)

    all_consilia: dict = {}

    for volume_dir in volumes:
        volume_data = process_volume(volume_dir, use_lb_model=use_lb_model)
        all_consilia.update(volume_data)

        # Write per-volume JSON
        per_volume_path = OUTPUT_DIR / f"{volume_dir.name}.json"
        with per_volume_path.open("w", encoding="utf-8") as fh:
            json.dump({"consilia": volume_data}, fh, ensure_ascii=False, indent=2)
        log.info("  Wrote %s", per_volume_path)

    # Write merged JSON
    merged_path = OUTPUT_DIR / "consilia.json"
    with merged_path.open("w", encoding="utf-8") as fh:
        json.dump({"consilia": all_consilia}, fh, ensure_ascii=False, indent=2)
    log.info("Wrote merged output: %s (%d total consilia)", merged_path, len(all_consilia))

    # Embedding stage
    embeddings_path = OUTPUT_DIR / "embeddings.safetensors"
    meta_path = OUTPUT_DIR / "embeddings_meta.json"
    if not embed:
        log.info("Embedding skipped (--no-embed).")
    elif not _embeddings_stale(merged_path, embeddings_path):
        log.info("Embeddings are up to date — skipping (use --no-embed to suppress this check).")
    else:
        log.info("Embeddings are stale or missing — running embedding stage …")
        from embed_consilia import embed as run_embed  # imported late: heavy dependency
        run_embed(
            input_path=merged_path,
            output_path=embeddings_path,
            meta_path=meta_path,
            fp16=embed_fp16,
            device=embed_device,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract consilia from PageXML")
    parser.add_argument(
        "--no-lb-model",
        action="store_true",
        help="Use heuristic (¬ = merge) instead of the Flair LB detector",
    )
    parser.add_argument(
        "--volume",
        metavar="NAME",
        help="Process only this volume directory (e.g. Baldo_Consilia_v1)",
    )
    parser.add_argument(
        "--no-embed",
        action="store_true",
        help="Skip the embedding stage (useful during development)",
    )
    parser.add_argument(
        "--embed-fp16",
        action="store_true",
        help="Load BGE-M3 in float16 to halve GPU memory usage (~1 GB vs ~2 GB)",
    )
    parser.add_argument(
        "--embed-device",
        metavar="DEVICE",
        default=None,
        help="Force embedding device: 'cuda', 'cpu', 'cuda:0', etc.",
    )
    args = parser.parse_args()
    run(
        volume_filter=args.volume,
        use_lb_model=not args.no_lb_model,
        embed=not args.no_embed,
        embed_fp16=args.embed_fp16,
        embed_device=args.embed_device,
    )


if __name__ == "__main__":
    main()
