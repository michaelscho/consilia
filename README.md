# Consilia

A pipeline for extracting and structuring medieval legal opinions (*consilia*) from Transkribus PageXML transcriptions of historical prints, with a static frontend for reading and searching the results — and an MCP server that lets Claude Desktop and Claude Code interrogate the corpus directly.

**Current corpus:** Baldo de Ubaldis, *Consilia* (Venice 1575), three volumes — **1 508 consilia** across 790 pages.

| Print | Pages | Consilia |
|---|---|---|
| `Baldo_Cons_Print_Venice_1575_v1` | 324 | 501 |
| `Baldo_Cons_Print_Venice_1575_v4` | 236 | 490 |
| `Baldo_Cons_Print_Venice_1575_v5` | 280 | 517 |

---

## Contents

1. [Prerequisites & setup](#prerequisites--setup)
2. [Project layout](#project-layout)
3. [Data layout & adding new prints](#data-layout--adding-new-prints)
4. [Layout correction (`fix_layout.py`)](#layout-correction-fix_layoutpy)
5. [Running the build](#running-the-build)
6. [Output format](#output-format)
7. [Debug tools](#debug-tools)
8. [Frontend](#frontend)
9. [MCP server](#mcp-server)
10. [How the pipeline works](#how-the-pipeline-works)

---

## Prerequisites & setup

**Python 3.10 or later** is required.

```bash
git clone https://github.com/your-username/Consilia.git
cd Consilia

python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Always invoke Python through the virtual environment to ensure all ML dependencies are available:

```bash
.venv/bin/python3 src/pipeline.py ...
# or, after activating: python3 src/pipeline.py ...
```

`requirements.txt` installs:

| Package | Purpose |
|---|---|
| `flair>=0.15.1` | Latin line-break detector (`mschonhardt/latin-contextual-lb-detector`) |
| `sentence-transformers>=3.0` | BGE-M3 multilingual embedding model |
| `safetensors>=0.4` | Compact binary tensor storage |
| `mcp[cli]>=1.0` | MCP server for Claude Desktop / Claude Code |

The Flair model and BGE-M3 (~2 GB) are downloaded automatically from HuggingFace on first use and cached in `~/.cache/huggingface/`.

---

## Project layout

```
data/
  {Author_VIAF}/
    author.json                       manual metadata: name, dates, note
    {print_id}/
      page/                           PageXML files from Transkribus
      *.jpg                           page scan images

src/
  build.py                Incremental build system — main entry point
  pipeline.py             Direct pipeline (no staleness check)
  fix_layout.py           Pre-processing: correct Transkribus tall-initial layout errors
  parse_pagexml.py        PageXML → Python dataclasses
  segment_consilia.py     Heading detection, state machine, text assembly
  lb_detector.py          Line-break dehyphenation (Flair model or heuristic)
  embed_consilia.py       BGE-M3 embedding → SafeTensors
  mcp_server.py           MCP server for Claude Desktop / Claude Code
  debug_visualize.py      Annotated JPEG output for inspection
  debug_consilium_list.py Export CSV overview of all consilia for debugging

output/
  consilia.json                       global merged consilium dictionary
  embeddings.safetensors              BGE-M3 Float32[N, 1024]
  embeddings_meta.json                index: ids, n-values, titles, author_viafs
  authors.json                        generated author index
  {Author_VIAF}/
    {print_id}.json                   per-print consilium dictionary
    consilia.json                     per-author merged dictionary
  debug/                              annotated page images (debug_visualize.py)

build_manifest.json       incremental build state (XML mtime per print)
index.html                reader frontend
search.html               keyword + semantic + similarity search frontend
vendor/
  minisearch.min.js       vendored MiniSearch (full-text search)
```

---

## Data layout & adding new prints

Prints are organised in a two-level hierarchy: `data/{Author_VIAF}/{print_id}/`. The VIAF number in the author folder name enables programmatic metadata lookup from the [Virtual International Authority File](https://viaf.org/).

```
data/
  Baldo_29618397/
    author.json
    Baldo_Cons_Print_Venice_1575_v1/    ← page files: 0001.xml … 0324.xml
      page/
      0001.jpg …
    Baldo_Cons_Print_Venice_1575_v4/    ← page files: page_001.xml … page_236.xml
      page/
    Baldo_Cons_Print_Venice_1575_v5/
      page/
```

Two filename formats are supported: `0001.xml` (v1) and `page_001.xml` (v4, v5). Both are sorted correctly by `load_pages()`. Folders whose names end in `_backup` are automatically skipped.

**To add a new print**, place it in the same structure and create `author.json` for new authors:

```bash
mkdir -p data/Bartolus_89597697
cat > data/Bartolus_89597697/author.json << 'EOF'
{
  "viaf": "89597697",
  "name": "Bartolus de Saxoferrato",
  "dates": "1313–1357",
  "note": "Italian jurist, professor at Perugia"
}
EOF

mkdir -p data/Bartolus_89597697/Bartolus_Cons_Venice_1585_v1/page
# → place PageXML files from Transkribus in page/
```

On the next `python src/build.py` run the new print is detected and processed automatically.

`author.json` fields:

| Field | Description |
|---|---|
| `viaf` | VIAF identifier (number only) |
| `name` | Display name |
| `dates` | Life dates (optional) |
| `note` | Brief biographical note (optional) |

---

## Layout correction (`fix_layout.py`)

Some prints contain a recurring Transkribus layout error caused by a tall initial letter: instead of being placed on its own line, the initial is merged with the second line of the body opener, producing two misaligned text regions. `fix_layout.py` detects and corrects these pairs before the pipeline runs.

**The error pattern:** A short truncated line (the continuation of the opener, far right) sits horizontally aligned with a tall line (the big initial merged with the rest of the opener, near the left margin). The script detects the pair geometrically, splits the merged line at the correct character position, and reorders the fragments.

```bash
# Dry run — show all detected pairs without writing
python src/fix_layout.py --show data/Baldo_29618397/Baldo_Cons_Print_Venice_1575_v4

# Apply fixes in place (edits XML files directly)
python src/fix_layout.py data/Baldo_29618397/Baldo_Cons_Print_Venice_1575_v4

# Single page
python src/fix_layout.py data/Baldo_29618397/Baldo_Cons_Print_Venice_1575_v4/page/page_003.xml
```

**Always make a backup before running** — the script modifies XML files in place:

```bash
cp -r data/Baldo_29618397/Baldo_Cons_Print_Venice_1575_v4 \
      data/Baldo_29618397/Baldo_Cons_Print_Venice_1575_v4_backup
```

Fixes applied to the current corpus:

| Print | Fixes |
|---|---|
| v1 | 309 |
| v4 | 30 |
| v5 | 10 |

After applying fixes, re-run the pipeline to regenerate the JSON and embeddings.

---

## Running the build

### Incremental build (`build.py`) — recommended

`build.py` checks which prints have changed XML files and re-processes only those. It then regenerates merged JSON outputs and re-runs the embedding stage when data changes.

```bash
# Process all stale prints, skip embedding
.venv/bin/python3 src/build.py --no-embed

# Full build with embeddings (float32, full quality)
.venv/bin/python3 src/build.py

# Full quality, half GPU memory (float16)
.venv/bin/python3 src/build.py --embed-fp16

# Force reprocess everything
.venv/bin/python3 src/build.py --force --no-embed

# Restrict to one author or one print
.venv/bin/python3 src/build.py --author Baldo_29618397 --no-embed
.venv/bin/python3 src/build.py --print Baldo_Cons_Print_Venice_1575_v4 --no-embed
```

### Direct pipeline (`pipeline.py`)

Processes all matching prints unconditionally — useful when iterating on the segmenter:

```bash
.venv/bin/python3 src/pipeline.py --no-lb-model --no-embed        # fast dev cycle
.venv/bin/python3 src/pipeline.py --embed-fp16                    # full run
.venv/bin/python3 src/pipeline.py \
  --print Baldo_Cons_Print_Venice_1575_v4 --no-lb-model --no-embed
```

**Typical runtimes** (RTX 3060, all three Baldo prints, 1 508 consilia):

| Stage | Mode | Time |
|---|---|---|
| Segmentation | heuristic (`--no-lb-model`) | ~5 s |
| Segmentation | Flair model (default) | ~20 min |
| Embedding | float32, GPU | ~90 s |
| Embedding | float16, GPU | ~45 s |
| Embedding | CPU only | ~10 min |

---

## Output format

All JSON outputs share the same structure — a single top-level `"consilia"` object keyed by consilium ID:

```json
{
  "consilia": {
    "consilium-baldo_cons_print_venice_1575_v1-44": {
      "id":          "consilium-baldo_cons_print_venice_1575_v1-44",
      "n":           44,
      "roman":       "XLIIII",
      "volume":      "Baldo_Cons_Print_Venice_1575_v1",
      "author_viaf": "Baldo_29618397",
      "title":       "CONSILIVM XLIIII.",
      "summary":     "1 Literae principis non sunt extensibiles…",
      "body": [
        "In Christi nomine. Dominus Bailardinus…",
        "† Secunda quaestio est…"
      ],
      "sources": [
        {
          "page": "0030.xml",
          "regions": [
            {
              "region_id": "r1",
              "type": "column_1",
              "coords": [[x, y], "…"],
              "first_line": "…",
              "last_line": "…"
            }
          ]
        }
      ]
    }
  }
}
```

| Field | Description |
|---|---|
| `id` | Unique ID: `consilium-{print_id_lower}-{n}` |
| `n` | Arabic numeral |
| `roman` | Roman numeral as printed |
| `volume` | Print directory name |
| `author_viaf` | Author directory name (contains VIAF ID) |
| `title` | Full heading line as transcribed |
| `summary` | Numbered proposition lines before the body opener |
| `body` | Body sections split at every `†` paragraph marker |
| `sources` | Page file and text-region provenance |

`output/embeddings_meta.json` maps vector row indices to consilium metadata:

```json
{
  "model": "BAAI/bge-m3",
  "dims": 1024,
  "n": 1508,
  "ids":          ["consilium-baldo_cons_print_venice_1575_v1-1", "…"],
  "ns":           [1, 2, "…"],
  "titles":       ["CONSILIVM I.", "…"],
  "author_viafs": ["Baldo_29618397", "…"]
}
```

---

## Debug tools

### Annotated page images (`debug_visualize.py`)

```bash
.venv/bin/python3 src/debug_visualize.py \
  --volume Baldo_Cons_Print_Venice_1575_v1
```

Writes colour-coded JPEG images to `output/debug/{print_id}/` and a `coverage.txt` summary.

| Box colour | Meaning |
|---|---|
| Green | Heading matched by regex |
| Orange | Heading detected by geometric fallback |
| Cyan | Heading recovered by merging split lines |
| Red | Heading with no body opener found |
| Purple | Near-miss candidate, not detected |

### Consilium CSV (`debug_consilium_list.py`)

Exports a spreadsheet of all consilia from the current output JSON — useful for cross-checking detection against the print:

```bash
.venv/bin/python3 src/debug_consilium_list.py --out debug_consilia.csv
.venv/bin/python3 src/debug_consilium_list.py --print v4 --out debug_v4.csv
```

Columns: `print`, `n`, `roman`, `title`, `has_body`, `body_start` (first 80 chars), `first_page`, `last_page`, `all_pages`.

The file is UTF-8 BOM encoded and opens directly in Excel / LibreOffice Calc.

---

## Frontend

The project ships two static HTML pages that run entirely client-side. They must be served over HTTP — not opened as `file://` URLs — because they load `output/consilia.json` and `output/embeddings.safetensors` via `fetch()`.

```bash
# Serve locally — open http://localhost:8000
.venv/bin/python3 -m http.server 8000

# Or use VS Code Live Server extension
```

> **Note:** Semantic text search calls the HuggingFace Inference API. Some browser/server combinations block this from `http://localhost` due to CORS. If that happens, either use the **Local model** option or enable HTTPS in your local server (VS Code Live Server: `liveServer.settings.https`). The **≈ Similar** and **Keyword** modes are not affected — they run entirely in the browser.

### Reader (`index.html`)

Four-panel layout:

- **Author / volume dropdowns** in the header
- **Sidebar** (230 px): scrollable consilium list, kept in sync via IntersectionObserver
- **Reader panel**: consilium cards with title, summary (grey left border), and body sections split at `†`
- **Image panel** (700 px): page scan with `‹ ›` navigation when a consilium spans multiple pages

Deep-link: `index.html?n=44` — used by the search page when you click a result.

Each consilium card has a **≈ Find similar consilia** link at the bottom that opens `search.html` in similarity mode for that consilium.

### Search (`search.html`)

Three search modes selectable via a button bar:

---

#### Keyword mode

Uses [MiniSearch](https://lucaong.github.io/minisearch/) for instant full-text search over the selected print.

- Latin normalisation: `j` = `i`, `v` = `u`, `ae`/`æ`/`ę` = `e`
- Prefix matching and fuzzy matching (terms longer than 4 characters)
- Field boost: title ×3, summary ×1.5, body ×1
- Results show matched fields, highlighted snippet from the best-matching field
- Stats panel: match count, field breakdown bars, distribution histogram, score range

---

#### Semantic mode

Uses precomputed BGE-M3 embeddings for concept-level retrieval. Queries can be in Latin, German, or English. Similarity is cosine similarity (dot product of unit vectors).

**Scope** — controls which consilia are searched:
- *This print* — only the currently selected volume
- *All Baldo* — all three Baldo prints
- *All corpus* — all loaded authors and prints

**Top K** — number of results to display (default 20, range 5–500). Changing scope or K re-renders instantly without a new embedding call.

**Result cards** show a color-coded score badge, a relative similarity bar, a highlighted snippet (query terms marked in yellow when they appear in the text), and a link to the reader.

**Embedding source** — two options:

| Option | Details |
|---|---|
| **HF API** | Query sent to `api-inference.huggingface.co/models/BAAI/bge-m3`. Requires a free HuggingFace token (create one at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)). Token stored in `localStorage`, never transmitted elsewhere. |
| **Local model** | `Xenova/bge-m3` (~130 MB quantized ONNX) downloaded once via CDN and cached in the browser. Fully offline after first use. No account needed. |

---

#### ≈ Similar mode

Finds the most semantically similar consilia to a chosen reference consilium. Uses precomputed embeddings only — **no HuggingFace API call required**.

Three ways to activate:
1. Click **≈** on any result card (keyword or semantic mode)
2. Click **≈ Find similar consilia** at the bottom of a consilium in the reader
3. Select the **≈ Similar** tab and enter a consilium number manually

**Scope pills** — three options:

| Scope | Description |
|---|---|
| *In this print* | Only consilia from the same volume |
| *All Baldo* | All volumes by Baldo |
| *All corpus* | All authors and prints |

Switching scope re-ranks instantly (~2 ms, pure dot products). The reference consilium is shown as a chip with its title; click × to clear.

---

#### Semantic map (sidebar)

Appears after the first semantic or similarity search, in the stats panel on the right.

A 2D PCA projection of all 1 508 embedding vectors, computed in the browser using power iteration (~100 ms, cached for the session). Each dot is one consilium.

**Color by:** toggle between *Volume* (color = print edition) and *Cluster* (color = thematic cluster). The current top-K results are highlighted as larger dots; the reference consilium (in Similar mode) is shown as a white circle with a colored ring.

Hover over a dot to see consilium number, title, and similarity score. Click to open in the reader.

**Thematic clustering (k-means):**

k-means is run on the 2D PCA coordinates (default k = 12, adjustable 3–20). The ↺ button re-seeds the clustering. Cluster labels are computed using TF-IDF across clusters: words appearing in many clusters (e.g. *possit*, *consilivm*) get low weight; words distinctive to one cluster (e.g. *feudum*, *emphyteusis*, *hereditas*) score high. Words appearing in fewer than 5 consilia corpus-wide are excluded (filters proper names and OCR fragments).

---

## MCP server

`src/mcp_server.py` exposes the corpus to AI assistants via the [Model Context Protocol](https://modelcontextprotocol.io/). It provides two tools:

| Tool | Description |
|---|---|
| `search_consilia(query, top_k=10, author_viaf=None)` | Semantic search. Returns ranked `{id, n, title, score, snippet}` list. |
| `get_consilium(consilium_id)` | Returns full consilium text: title, summary, body sections. |

### Embedding modes

**Mode 1 — HuggingFace API (default)**

The query is sent to `api-inference.huggingface.co/models/BAAI/bge-m3`. No model download required. For heavier use, provide a token via the `HF_TOKEN` environment variable.

**Mode 2 — Local model**

Set `CONSILIA_LOCAL_MODEL=1` to load `BAAI/bge-m3` via `sentence-transformers`. The model (~2 GB) caches in `~/.cache/huggingface/` after first download.

| | HF API | Local model |
|---|---|---|
| Setup effort | none | one-time ~2 GB download |
| Internet required | yes | no (after download) |
| Speed per query | ~1–3 s | ~0.1 s (GPU) / ~1 s (CPU) |
| Privacy | query sent to HuggingFace | stays on your machine |

### Connecting to Claude Desktop

Edit `claude_desktop_config.json`:

- **Linux:** `~/.config/Claude/claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "consilia": {
      "command": "/path/to/Consilia/.venv/bin/python",
      "args": ["/path/to/Consilia/src/mcp_server.py"],
      "cwd": "/path/to/Consilia",
      "env": { "HF_TOKEN": "hf_…" }
    }
  }
}
```

Omit `env` to use the anonymous HF API. Add `"CONSILIA_LOCAL_MODEL": "1"` to use the local model. Restart Claude Desktop after saving.

### Connecting to Claude Code

Add to `.claude/settings.json` in the project root (project-scoped) or `~/.claude/settings.json` (user-wide):

```json
{
  "mcpServers": {
    "consilia": {
      "command": "/path/to/Consilia/.venv/bin/python",
      "args": ["/path/to/Consilia/src/mcp_server.py"],
      "cwd": "/path/to/Consilia",
      "env": { "HF_TOKEN": "hf_…" }
    }
  }
}
```

Verify with `/mcp` inside a Claude Code session. Then query the corpus directly:

```
search for consilia about inheritance between illegitimate children
show me the full text of consilium 267
```

---

## How the pipeline works

### 1. PageXML parsing (`parse_pagexml.py`)

Reads Transkribus PageXML files. Each page yields `TextRegion` objects with `TextLine` objects containing Unicode text, polygon coordinates, and a soft-hyphen flag (`¬`). Running-header regions (type `header`) are skipped.

### 2. Layout correction (`fix_layout.py`)

Applied as a pre-processing step on the raw XML before segmentation. Detects pairs of misaligned lines caused by a tall printed initial: a short truncated fragment (continuation) and a tall merged line (initial + opener text). The merged line is split at the correct character position and the fragments are reordered.

Detection thresholds: truncated line narrower than 15% of column width; merged line starts within 10% of left margin; minimum 5px vertical overlap between the two lines. The split position is determined by matching the opener text prefix.

### 3. Consilium segmentation (`segment_consilia.py`)

Turns the flat line stream into structured consilium records via a state machine with several pre-processing passes.

#### Pre-processing

**Colinear split merge**: Transkribus occasionally segments a single heading line into two side-by-side `TextLine` elements. Pairs at the same vertical position are merged before any other processing.

**Text-based split-heading merge**: Consecutive narrow all-caps lines that individually do not match the heading regex but together do (in any ordering) are merged.

#### Heading detection

1. **Regex** (`_RE_HEADING`): Matches `CONSILIVM` + Roman numeral with extensive OCR-error variants (doubled letters, missing letters, misread letters, truncated prefixes, `S`→`C` substitution in numerals).
2. **OCR normalisation**: `e` is replaced by `C` when sandwiched between Roman numeral characters before a second regex pass.
3. **Geometric fallback**: Lines narrower than 58% of column width, all-caps, not numbered items — treated as headings when in BODY or BEFORE state.
4. **Arabic-numeral headings**: Handles `Consilium 473. et 414.` format; both numbers are extracted and a clone emitted.

#### Body opener detection

After the heading and numbered summary propositions, the body begins when a line matches any of the following:

- **Liturgical openers**: *In Christi nomine*, *In nomine Dei/Domini/Sancti*, and OCR variants (soft-hyphen splits, dropped initials)
- **Procedural openers**: *Ad evidentiam*, *Primo puncto [dicendum est]*, *Considerato*, *Praemittendum [est]*, *Punctus quaestionis/vtrum*
- **Dagger marker**: line starts with `†` (paragraph opener in the original print)

If no opener is found during streaming, a multi-pass recovery runs at flush time:

1. Re-scan summary lines for any text-based opener or leading `†`
2. Detect page artifacts (`Consilia.` running header) followed by a lowercase-starting line
3. Search for an embedded `†` within the first 40 characters of any line in the first 10 summary lines
4. Last resort: split after the last short (< 65 chars) complete proposition in the first 10 summary lines

#### State machine

```
BEFORE  → heading detected  → SUMMARY
SUMMARY → body opener / †   → BODY
SUMMARY → next heading       → SUMMARY  [flush previous]
BODY    → next heading       → BODY     [flush previous]
```

#### Sequence healing

After segmentation, OCR-garbled Roman numerals are corrected: a consilium whose `n` is out of sequence relative to its page-order neighbours is reclassified to the missing number in the range `(prev_n, next_n)` when exactly one number is missing there.

#### Section labels

`CASVS`, `CASIVS`, `ADDITIO`, and variants are recognised as section sub-headings within a consilium and do not trigger a new consilium boundary.

#### Text assembly

- **Summary**: lines joined by the Flair LB model (or `¬`-heuristic). Standalone marginal numbers dropped.
- **Body**: all body lines joined into one text, then split at every `†`. Marginal paragraph numbers stripped at line starts.

### 4. Line-break dehyphenation (`lb_detector.py`)

**Heuristic** (`--no-lb-model`): lines ending with `¬` are merged directly; others get a space.

**Flair model** (default): each adjacent pair is passed to `mschonhardt/latin-contextual-lb-detector` as `"line_i <lb/> line_i+1"`. The model predicts `WB` (merge) or `NB` (space) on the `<lb/>` token. All pairs for a section are batch-predicted in a single call.

### 5. Embedding (`embed_consilia.py`)

Generates a 1024-dimensional BGE-M3 vector for each consilium (title + summary + body joined). Saved as `output/embeddings.safetensors` (row-major float32) alongside `output/embeddings_meta.json`.

BGE-M3 supports Latin, German, English, and 100+ other languages in the same vector space — cross-lingual queries work without translation. The model processes up to 8192 tokens per passage.

**SafeTensors layout** (for the inline JavaScript parser in `search.html`):

```
[8 bytes: little-endian uint64, header length]
[header_length bytes: UTF-8 JSON metadata]
[raw float32 data, row-major, shape [N, 1024]]
```
