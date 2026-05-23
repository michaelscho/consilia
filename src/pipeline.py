"""
Main pipeline: walk data/ → parse PageXML → segment consilia → write JSON → embed.

Usage:
    python pipeline.py [--no-lb-model] [--author AUTHOR_DIR] [--print PRINT_DIR] [--no-embed]

Options:
    --no-lb-model   Use heuristic dehyphenation (¬ → merge) instead of Flair.
    --author NAME   Process only prints belonging to this author directory (e.g. Baldo_29618397).
    --print NAME    Process only the named print directory (e.g. Baldo_Cons_Print_Venice_1575_v1).
    --no-embed      Skip the embedding stage even if embeddings are stale.
    --embed-fp16    Load BGE-M3 in float16 (~1 GB VRAM instead of ~2 GB).
    --embed-device  Force device for embedding: 'cuda', 'cpu', 'cuda:0', etc.

Output:
    output/{author_viaf}/{print_id}.json        per-print consilium dictionary
    output/{author_viaf}/consilia.json          per-author merged dictionary
    output/consilia.json                        merged dictionary across all authors/prints
    output/embeddings.safetensors               BGE-M3 Float32[N, 1024] (when stale)
    output/embeddings_meta.json                 embedding metadata
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
# Print discovery
# ---------------------------------------------------------------------------


def find_prints(data_dir: Path) -> list[tuple[str, str, Path]]:
    """Return (author_viaf, print_id, print_dir) for every known print."""
    result = []
    for author_dir in sorted(data_dir.iterdir()):
        if not author_dir.is_dir():
            continue
        viaf = author_dir.name
        for print_dir in sorted(author_dir.iterdir()):
            if print_dir.is_dir() and (print_dir / "page").is_dir():
                result.append((viaf, print_dir.name, print_dir))
    return result


# ---------------------------------------------------------------------------
# Per-print processing
# ---------------------------------------------------------------------------


def load_pages(print_dir: Path) -> list[PageData]:
    page_dir = print_dir / "page"
    xml_files = sorted(page_dir.glob("*.xml"), key=lambda p: int(p.stem))
    pages: list[PageData] = []
    for xml_file in xml_files:
        try:
            pages.append(parse_pagexml(xml_file))
        except Exception as exc:
            log.warning("Could not parse %s: %s", xml_file.name, exc)
    log.info("  Loaded %d pages from %s", len(pages), print_dir.name)
    return pages


def process_print(print_dir: Path, author_viaf: str, use_lb_model: bool = True) -> dict:
    """Process one print and return a dict keyed by consilium id."""
    log.info("Processing print: %s / %s", author_viaf, print_dir.name)
    pages = load_pages(print_dir)

    segmenter = ConsiliumSegmenter(
        volume=print_dir.name,
        author_viaf=author_viaf,
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
    author_filter: str | None = None,
    print_filter: str | None = None,
    use_lb_model: bool = True,
    embed: bool = True,
    embed_fp16: bool = False,
    embed_device: str | None = None,
) -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)

    prints = find_prints(DATA_DIR)
    if not prints:
        log.error("No prints found in %s", DATA_DIR)
        sys.exit(1)

    if author_filter:
        prints = [p for p in prints if p[0] == author_filter]
        if not prints:
            log.error("Author '%s' not found in %s", author_filter, DATA_DIR)
            sys.exit(1)

    if print_filter:
        prints = [p for p in prints if p[1] == print_filter]
        if not prints:
            log.error("Print '%s' not found in %s", print_filter, DATA_DIR)
            sys.exit(1)

    all_consilia: dict = {}
    by_author: dict[str, dict] = {}

    for author_viaf, print_id, print_dir in prints:
        print_data = process_print(print_dir, author_viaf, use_lb_model=use_lb_model)

        # Accumulate for merged outputs
        all_consilia.update(print_data)
        by_author.setdefault(author_viaf, {}).update(print_data)

        # Write per-print JSON
        author_out_dir = OUTPUT_DIR / author_viaf
        author_out_dir.mkdir(exist_ok=True)
        per_print_path = author_out_dir / f"{print_id}.json"
        with per_print_path.open("w", encoding="utf-8") as fh:
            json.dump({"consilia": print_data}, fh, ensure_ascii=False, indent=2)
        log.info("  Wrote %s", per_print_path)

    # Write per-author merged JSONs
    for author_viaf, author_data in by_author.items():
        author_out_dir = OUTPUT_DIR / author_viaf
        author_out_dir.mkdir(exist_ok=True)
        per_author_path = author_out_dir / "consilia.json"
        with per_author_path.open("w", encoding="utf-8") as fh:
            json.dump({"consilia": author_data}, fh, ensure_ascii=False, indent=2)
        log.info("Wrote per-author output: %s (%d consilia)", per_author_path, len(author_data))

    # Write global merged JSON
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
        "--author",
        metavar="NAME",
        help="Process only prints in this author directory (e.g. Baldo_29618397)",
    )
    parser.add_argument(
        "--print",
        metavar="NAME",
        dest="print_filter",
        help="Process only this print directory (e.g. Baldo_Cons_Print_Venice_1575_v1)",
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
        author_filter=args.author,
        print_filter=args.print_filter,
        use_lb_model=not args.no_lb_model,
        embed=not args.no_embed,
        embed_fp16=args.embed_fp16,
        embed_device=args.embed_device,
    )


if __name__ == "__main__":
    main()
