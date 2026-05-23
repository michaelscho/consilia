# Consilia

**Note: This repo is still under development.**

A pipeline for extracting and structuring medieval legal opinions (*consilia*) from Transkribus PageXML transcriptions of historical prints, with a static frontend for reading and searching the results.

The current dataset is the first volume of Baldo de Ubaldis, *Consilia* (late 15th-century print, 324 pages, 500 numbered opinions). The pipeline recovers **498 of 500** consilium numbers with the two missing (n=251, n=356) are genuinely absent from the print.

---

## Project layout

```
data/
  Baldo_Consilia_v1/
    page/           PageXML files (0001.xml … 0324.xml) from Transkribus
    0001.jpg …      Page images (used by the reader and debug visualiser)

src/
  pipeline.py           Entry point — orchestrates all stages
  parse_pagexml.py      PageXML -> Python dataclasses
  segment_consilia.py   Boundary detection and text extraction
  lb_detector.py        Line-break dehyphenation (Flair model)
  embed_consilia.py     BGE-M3 embedding -> SafeTensors
  debug_visualize.py    Annotated JPEG output for inspection

output/
  Baldo_Consilia_v1.json   Per-volume structured JSON
  consilia.json            Merged JSON across all volumes
  embeddings.safetensors   BGE-M3 Float32[501, 1024] embeddings
  embeddings_meta.json     Embedding metadata (ids, n-values, model)
  debug/                   Annotated page images (from debug_visualize.py)

index.html          Reader (sidebar + reader + page image panel)
search.html         Search page (keyword + semantic)
vendor/
  minisearch.min.js   Vendored MiniSearch full-text search library

requirements.txt
```

---

## Running the pipeline

```bash
# Fast heuristic mode: only ¬-marked line breaks are merged, no embedding
python src/pipeline.py --no-lb-model --no-embed

# Full model mode: Flair classifies every line break, then re-embeds if stale
python src/pipeline.py --embed-fp16

# Single volume, skip embedding
python src/pipeline.py --volume Baldo_Consilia_v1 --no-embed

# Run embedding separately (e.g. after manual edits to consilia.json)
python src/embed_consilia.py --fp16
```

**Embedding is skipped automatically** when `output/embeddings.safetensors` is newer than `output/consilia.json`. Pass `--no-embed` to always skip it (useful during development iterations on the segmenter).

The Flair model (`mschonhardt/latin-contextual-lb-detector`) and the BGE-M3 model (`BAAI/bge-m3`) are downloaded automatically from Hugging Face on first use.

---

## Output format

Both JSON files have the same structure: a single top-level `"consilia"` object keyed by consilium ID.

```json
{
  "consilia": {
    "consilium-baldo_consilia_v1-44": {
      "id":      "consilium-baldo_consilia_v1-44",
      "n":       44,
      "roman":   "XLIIII",
      "volume":  "Baldo_Consilia_v1",
      "title":   "CONSILIVM XLIIII.",
      "summary": "1 Literae principis non sunt extensibiles…",
      "body": [
        "In Christi nomine. Dominus Bailardinus…",
        "† Secunda quaestio est…",
        "† Tertia quaestio…"
      ],
      "sources": [
        {
          "page": "0030.xml",
          "regions": [
            {
              "region_id": "…",
              "type":      "column_1",
              "coords":    [[x,y], …],
              "first_line": "…",
              "last_line":  "…"
            }
          ]
        }
      ]
    }
  }
}
```

**Fields:**

| Field | Description |
|---|---|
| `id` | Unique identifier: `consilium-{volume_lower}-{n}` |
| `n` | Arabic numeral (1–500) |
| `roman` | Roman numeral as printed |
| `volume` | Source volume directory name |
| `title` | Full heading line as transcribed |
| `summary` | Numbered summary items before the body opener |
| `body` | List of body sections, split at every `†` paragraph marker |
| `sources` | Page file and text-region provenance for each span |

Duplicate `n` values (genuine duplicates in the print) get a `-2`, `-3` suffix on the ID.

---

## How the pipeline works

### 1. PageXML parsing (`parse_pagexml.py`)

Reads Transkribus PageXML files. Each page yields a list of `TextRegion` objects, each containing `TextLine` objects with:
- Unicode text
- Polygon coordinates (used for geometry-based detection)
- A soft-hyphen flag (`¬`) indicating a word split at the line end

Running-header regions (type `header`) are skipped everywhere.

### 2. Consilium segmentation (`segment_consilia.py`)

This is the core stage. It turns the flat stream of text lines into structured consilium records using a state machine with several pre-processing passes.

#### Pre-processing passes

**Colinear split merge** (`_merge_colinear_splits`): Transkribus occasionally segments a single printed heading line into two side-by-side `TextLine` objects (e.g. `CONSILIVM` and `CCCLIII.` as separate elements in the same text region). Lines in the same region at the same vertical position that together match the heading regex are merged before any other processing. Recovered 4 headings this way.

**Text-based split-heading merge** (`merge_split_headings`): Consecutive narrow all-caps lines that individually do not match the heading regex but together do (in any ordering) are merged. Handles cases like `['CCLXIX.', 'CONSILIVM.']` → `'CONSILIVM CCLXIX'`. Recovered 7 headings.

#### Heading detection

Three strategies in priority order:

1. **Regex** (`_RE_HEADING`): Matches `CONSILIVM` + Roman numeral with extensive OCR-error variants:
   - Standard and doubled-I: `CONSILI`, `CONSILII`, `CONSIILI`
   - Missing letters: `COSILI`, `CNSILI`, `CONILI`, `ONSILI`, `NSILI`
   - Misread letters: `CONSLLI`, `CONSILR`
   - Severely truncated prefixes: `LIVM`, `IVM`, `VM` (up to 4 leading garbage characters)
   - Optional `Ad idem.` prefix
   - Optional leading marginal paragraph number
   - Trailing OCR noise (up to 20 characters of garbage after the dots)
   - Roman numerals: `S` treated as OCR misread of `C`

2. **OCR normalisation** (`_normalize_ocr_e`): Before applying the regex a second time, `e` is replaced by `C` when sandwiched between Roman numeral characters (handles `CCceV` → `CCCCV` = 405). Applied surgically to avoid false matches in Latin body text.

3. **Geometric fallback**: Lines narrower than 58% of their column width, consisting of all-caps text with at least 4 alphabetic characters, that are not numbered summary items, are treated as headings when the segmenter is in BODY or BEFORE state. Recovers headings where the numeral was so garbled the regex gives up.

4. **Arabic-numeral headings** (`_RE_ARABIC_HEADING`): Handles the non-standard format `Consilium 473. et 414.` where two consilia are referenced with Arabic numerals. Both numbers are extracted; the secondary one (OCR garbled) is emitted as a clone and corrected by sequence healing.

#### State machine

```
BEFORE → (heading detected) → SUMMARY
SUMMARY → (body opener: "In Christi nomine…" or leading †) → BODY
SUMMARY → (next heading) → SUMMARY   [previous consilium flushed]
BODY    → (next heading) → SUMMARY   [previous consilium flushed]
```

Summary lines are accumulated until a body opener is found. Body lines are accumulated until the next heading.

#### Sequence healing (`_heal_sequence`)

After segmentation, a post-processing pass corrects OCR-garbled Roman numerals that produced a plausible but wrong number. For each consilium whose `n` is out of sequence relative to its neighbours in page order:

- If exactly one number is missing in the range `(prev_n, next_n)`, the consilium is reclassified to that number.
- Geometric headings with `n=0` are assigned a number if only one is missing between their neighbours.
- All IDs are rebuilt after healing to remove stale duplicate suffixes.

Recovered ~18 consilia via healing (e.g. `CXIII`→93, `CCXXXVIII`→228).

#### Text assembly

**Summary**: Lines are joined with the Flair model (or `¬`-heuristic). Numbered summary items (e.g. `1 Feudum an…`) retain their leading numbers. Standalone marginal-number lines (a bare `1` with no content) are dropped.

**Body sections**: All body lines are joined into a full text first, then split at every `†` character (keeping `†` at the start of its section). This correctly handles `†` markers that appear mid-line in the XML (where the physical line boundary cut through the printed text). Marginal paragraph numbers (1–10) at line starts are stripped before joining.

### 3. Line-break dehyphenation (`lb_detector.py`)

Joins the lines of each text section into a single string. Two modes:

**Heuristic** (`--no-lb-model`): Lines ending with `¬` are merged directly with the next line (word continues); all other line breaks get a space. Fast but misses invisible breaks.

**Flair model** (default): Each adjacent line pair is passed as one sentence `"line_i <lb/> line_i+1"` to the sequence tagger `mschonhardt/latin-contextual-lb-detector`. The model predicts a label on the `<lb/>` token:
- `WB` → merge the two lines directly (word continues across the break)
- `NB` → insert a space (word boundary at the line break)

All pairs for a section are batch-predicted in a single `tagger.predict()` call.

### 4. Embedding (`embed_consilia.py`)

Generates a dense vector representation for every consilium using [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3), a multilingual sentence embedding model with 1024 dimensions and support for up to 8192 tokens. Each consilium is represented by its title, summary, and body sections joined into one passage.

The embeddings are saved as `output/embeddings.safetensors` (a compact binary format) alongside `output/embeddings_meta.json`, which maps vector indices to consilium IDs, `n`-values, and titles.

**Why BGE-M3?** Queries can be posed in Latin, German, or English — all map to the same vector space, so a German question finds the corresponding Latin texts without any translation.

**Staleness check**: The pipeline only re-runs the embedding stage when `consilia.json` has been modified more recently than `embeddings.safetensors`. This means routine re-runs of the segmenter (e.g. for debugging) don't trigger an unnecessary ~8-second GPU pass.

---

## Frontend

The project ships two static HTML pages that work entirely client-side, requiring no server beyond a basic file host (e.g. GitHub Pages).

### Reader (`index.html`)

Three-panel layout:
- **Sidebar** (230 px): scrollable list of all consilia; stays in sync with the reader via IntersectionObserver
- **Reader**: paginated consilium cards showing the title, summary (with left grey border), and body sections split at every `†`
- **Image panel** (700 px): the corresponding page image(s) from the Transkribus scan, with `‹` / `›` navigation when a consilium spans multiple pages; hidden on screens narrower than 1100 px

Deep-linking: `index.html?n=44` scrolls directly to consilium 44.

### Search (`search.html`)

Two search modes selectable via toggle:

**Keyword mode** uses [MiniSearch](https://lucaong.github.io/minisearch/) for instant full-text search with Latin normalisation:
- `j` = `i`, `v` = `u`, `ae`/`æ`/`ę` = `e`
- Prefix matching and fuzzy matching (terms longer than 4 characters)
- Field boost: title ×3, summary ×1.5, body ×1
- Results show matched fields (title / summary / body), a highlighted snippet from the best-matching field, and a stats panel with field breakdown bars, a distribution histogram, and score range

**Semantic mode** uses the precomputed BGE-M3 embeddings for concept-level search. Queries can be in Latin, German, or English. Two embedding paths:

| Path | How it works |
|---|---|
| HF Serverless API | Query is sent to `api-inference.huggingface.co/models/BAAI/bge-m3` (free tier). No download required; an optional HF token raises rate limits. |
| Local ONNX model | `Xenova/bge-m3` (~130 MB, quantized) is downloaded via the `@xenova/transformers` CDN and cached in the browser. Fully offline after the first download. |

Both paths produce identical normalised 1024-dimensional vectors compatible with the precomputed embeddings. Similarity is computed as the dot product of unit vectors (cosine similarity). Results show the top 20 consilia with:
- A color-coded similarity score (warm brown for high similarity ≥ 0.65, amber for medium, grey for low)
- A relative similarity bar showing each result's score as a proportion of the top result
- A snippet of the summary (or body if no summary), giving immediate context

The SafeTensors file is parsed entirely in JavaScript without any library — an 8-byte little-endian header length, followed by a JSON metadata block, followed by the raw float32 data.

---

## Debug visualiser (`debug_visualize.py`)

Writes annotated JPEG images and a coverage report for inspection:

```bash
python src/debug_visualize.py --volume Baldo_Consilia_v1
python src/debug_visualize.py --volume Baldo_Consilia_v1 --pages-only  # report only
```

Output in `output/debug/Baldo_Consilia_v1/`:
- `{page}_debug.jpg` — page image with colour-coded bounding boxes
- `coverage.txt` — detected consilium numbers, gaps, per-page heading list

Box colours: green = regex match, orange = geometric fallback, cyan = merged split heading, red = heading with no body opener, purple = near-miss candidate not detected.
