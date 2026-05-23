"""
Detect consilium boundaries and extract title / summary / body from a stream of
PageXML-derived text lines.

Detection strategy (in priority order):
  1. Regex: line matches CONSILIVM / CONSILIUM + Roman numeral pattern
  2. Geometric fallback: line is significantly narrower than its column AND
     appears to be all-caps (likely a corrupted heading missed by regex)

Body-opener detection (within a consilium's summary section):
  1. Regex: line contains "In Christi nomine" or Latin variants
  2. Dagger prefix: line starts with † (paragraph marker in the body)
  3. Geometric fallback: first narrow, uppercase line after summary items
     that doesn't look like a numbered-item continuation
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Optional

from parse_pagexml import PageData, TextLine, TextRegion
from lb_detector import join_lines

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Roman-numeral helpers
# ---------------------------------------------------------------------------

_WORD_FORMS: dict[str, int] = {
    "PRIMVM": 1, "SECVNDVM": 2, "TERTIVM": 3, "QVARTVM": 4,
    "QVINTVM": 5, "SEXTVM": 6, "SEPTIMVM": 7, "OCTAVVM": 8,
    "NONVM": 9, "DECIMVM": 10,
}

_ROMAN_PAIRS = [
    ("M", 1000), ("CM", 900), ("D", 500), ("CD", 400),
    ("C", 100), ("XC", 90), ("L", 50), ("XL", 40),
    ("X", 10), ("IX", 9), ("V", 5), ("IV", 4), ("I", 1),
]


def roman_to_int(s: str) -> Optional[int]:
    s = s.upper().strip().rstrip(".").replace(" ", "")  # strip spaces (handles "CC CCXXX")
    s = s.replace("S", "C")  # S is a common OCR misread of C (handles CCSCXXXVIII → CCCCXXXVIII)
    s = s.replace("E", "C")  # e is a common OCR misread of C (handles CCceV → CCCCV=405)
    if s in _WORD_FORMS:
        return _WORD_FORMS[s]
    result, i = 0, 0
    while i < len(s):
        for numeral, value in _ROMAN_PAIRS:
            if s[i: i + len(numeral)] == numeral:
                result += value
                i += len(numeral)
                break
        else:
            return None  # unrecognised character
    return result or None


# ---------------------------------------------------------------------------
# Regex patterns
# ---------------------------------------------------------------------------

_RE_HEADING = re.compile(
    # Optional "Ad idem." / "Ad idem " prefix (period may be absent in OCR)
    r"^(?:(?:A[Dd]\s*idem|Adidem)\s*\.?\s+)?"
    # Optional leading paragraph number
    r"(?:\d+\s+)?"
    r"(?:"
    # Standard variants: 0-2 leading OCR garbage chars + CONSILIVM stem + VM/UM ending
    #   CONSILI / CONSILII  – standard and double-I-at-end (CCONSILIIVM)
    #   CONSIILI            – double-I-in-middle (CONSIILIVM)
    #   COSILI              – missing N
    #   CNSILI              – missing O
    #   CONILI              – missing S
    #   CONSLLI             – LL instead of LI (CONSLLIVM)
    #   CONSILR             – R instead of final I (CONSILRVM)
    #   ONSILI              – missing leading C
    #   NSILI               – missing leading CO
    r"[A-Z]{0,2}(?:CONSILI{1,2}|CONSIILI|COSILI|CNSILI|CONILI|CONSLLI|CONSILR|ONSILI|NSILI)[OUV][MN]?"
    r"|"
    # Severely truncated suffix variants where the CONSIL- prefix is entirely missing;
    # up to 4 leading garbage chars then the tail LI[UV]M / I[UV]M / [UV]M
    # (handles LIVM CCLIII. → n=253, ILIVM CCCC.  . → n=400, VM CCCCXLIIII. → n=444)
    r"[A-Z]{0,4}(?:LI[UV]M|I[UV]M|[UV]M)"
    r")"
    r"\s*\.?\s+"                               # separator (optional period + space)
    r"(PRIMVM|SECVNDVM|TERTIVM|QVARTVM|QVINTVM|SEXTVM|SEPTIMVM"
    r"|OCTAVVM|NONVM|DECIMVM"
    r"|[IVXLCDMS]+(?:\s[IVXLCDMS]{2,})*)"          # roman numeral; S→C OCR noise
                                               # (handles CCSCXXXVIII → CCCCXXXVIII=438)
    r"\s*(?:[.?]{1,3}(?:[A-Za-z\s.?]{0,20})?)?\s*$",  # trailing: 0-3 dots/? + optional short text
    re.IGNORECASE,
)

# Normalise OCR misread 'e'→'C' only when sandwiched between Roman-numeral chars
# (handles CCceV → CCcCV → roman_to_int → CCCCV = 405; avoids matching body text)
_RE_NUMERAL_E = re.compile(r"(?<=[IVXLCDMSivxlcdms])[eE](?=[IVXLCDMSivxlcdms.])")

# Marginal paragraph numbers 1-10 that Transkribus includes at line starts.
# Matches both "1 text..." (number + space) and bare "1" (standalone).
# Put 10 before [1-9] so "10" is not tokenised as "1".
_RE_LEADING_NUMBER = re.compile(r"^(?:10|[1-9])(?:\s+|$)")

# Matches lines that consist *solely* of a marginal number (no content after it).
_RE_STANDALONE_NUMBER = re.compile(r"^(?:10|[1-9])\s*$")


def _normalize_ocr_e(text: str) -> str:
    return _RE_NUMERAL_E.sub("C", text)


def _strip_leading_number(text: str) -> str:
    """Remove marginal paragraph numbers (1–10) from the start of a line."""
    return _RE_LEADING_NUMBER.sub("", text, count=1)


# Alternative heading format: Arabic numerals, e.g. "Consilium 473. et 414."
# The second number is an OCR-variant of the true number (healed by _heal_sequence).
_RE_ARABIC_HEADING = re.compile(
    r"^Consilium\s+(\d+)\.(?:\s*et\s+(\d+)\.)?\s*$",
    re.IGNORECASE,
)

# Pure Roman numeral / word-fragment patterns to reject from geometric fallback
_RE_PURE_NUMERAL = re.compile(r"^[IVXLCDM\s.]+$", re.IGNORECASE)
_RE_WORD_FRAGMENT = re.compile(r"^(?:VM|LVM|IVM|LIVM|LIVM?)\b", re.IGNORECASE)

# Section labels that are NOT consilium headings — they belong to surrounding content.
#   CASVS / CNSVS / OASVS  — OCR variants of "casus" (legal case description)
#   ADDITIO BAL. / ADDIIIO RAL. — OCR variants of "Additio Bal[di]" (author addendum)
_RE_SECTION_LABEL = re.compile(
    r"^(?:"
    r"[A-Z]{0,2}[AC][ANO]?SVS"        # CASVS, CNSVS, OASVS …
    r"|ADDI[A-Z]{1,3}O\s+[A-Z]{2,4}"  # ADDITIO BAL., ADDIIIO RAL. …
    r")\s*\.?\s*$",
    re.IGNORECASE,
)

_RE_SUMMARY_ITEM = re.compile(r"^\d+\s+[A-Z]")  # "1 Feudum an …"

# Body openers: "In Christi nomine", "In nomine Christi / Dei / Domini", …
# Optionally preceded by a paragraph number ("1 IN Christi nomine.")
_RE_BODY_OPENER = re.compile(
    r"(?:CHRISTI\s+NOMINE"
    r"|NOMINE\s+CHRISTI"
    r"|IN\s+NOMINE\s+(?:CHRISTI|DEI|DOMINI|SANCTI)"
    r"|IN\s+CHRISTI\s+NOMINE)",
    re.IGNORECASE,
)

# Dagger paragraph marker — reliable body indicator when leading a line
_RE_DAGGER_LEAD = re.compile(r"^[††]")

# ---------------------------------------------------------------------------
# Geometric threshold
# ---------------------------------------------------------------------------

_SHORT_LINE_RATIO = 0.58  # lines narrower than this fraction of column width
                           # are candidates for headings or body openers


# ---------------------------------------------------------------------------
# Split-heading pre-processing
# ---------------------------------------------------------------------------


def _merge_colinear_splits(lines: list["LineRef"]) -> list["LineRef"]:
    """
    Preflight pass: merge consecutive lines from the *same region* that sit at
    the same vertical position (side-by-side layout splits) when doing so
    produces a valid consilium heading that neither line individually matches.

    Transkribus occasionally segments a single printed heading line into two
    TextLines — e.g. 'CONSILIVM' (left) + 'CCCLIII.' (right) — because the
    two halves are typeset slightly apart.  Joining them by x-order (no space
    when touching, space when there is a small gap) produces 'CONSILIVM
    CCCLIII.' which the regex then catches correctly.

    Guard: if either line already matches _RE_HEADING we leave it alone so
    we never disturb a working detection.
    """
    result: list["LineRef"] = []
    i = 0
    while i < len(lines):
        lr = lines[i]
        if i + 1 >= len(lines):
            result.append(lr)
            i += 1
            continue

        nxt = lines[i + 1]

        # Must be same page and same region
        if lr.page_filename != nxt.page_filename or lr.region_id != nxt.region_id:
            result.append(lr)
            i += 1
            continue

        # Don't disturb lines that already match the heading regex
        if _RE_HEADING.match(lr.text) or _RE_HEADING.match(nxt.text):
            result.append(lr)
            i += 1
            continue

        # Compute y-midpoints and heights from line_coords
        a_ys = [p[1] for p in lr.line_coords]
        b_ys = [p[1] for p in nxt.line_coords]
        ya_mid = (min(a_ys) + max(a_ys)) / 2
        yb_mid = (min(b_ys) + max(b_ys)) / 2
        avg_h = max(max(a_ys) - min(a_ys), max(b_ys) - min(b_ys), 1)

        if abs(ya_mid - yb_mid) >= avg_h * 0.4:
            result.append(lr)
            i += 1
            continue

        # Determine left / right order by x-min
        a_xs = [p[0] for p in lr.line_coords]
        b_xs = [p[0] for p in nxt.line_coords]
        if min(a_xs) <= min(b_xs):
            left, right = lr, nxt
            x_gap = min(b_xs) - max(a_xs)
        else:
            left, right = nxt, lr
            x_gap = min(a_xs) - max(b_xs)

        # Reject if lines are too far apart (different columns)
        if x_gap > avg_h * 1.5:
            result.append(lr)
            i += 1
            continue

        sep = "" if x_gap < avg_h * 0.5 else " "
        merged_text = (left.text + sep + right.text).strip()

        if not _RE_HEADING.match(merged_text):
            result.append(lr)
            i += 1
            continue

        merged = _make_merged_lineref(left, right, merged_text)
        log.info(
            "Colinear merge on %s: %r + %r → %r",
            lr.page_filename, lr.text, nxt.text, merged_text,
        )
        result.append(merged)
        i += 2

    return result


def _is_heading_fragment(lr: "LineRef") -> bool:
    """Short all-caps line that could be part of a multi-line heading."""
    text = lr.text
    if text.rstrip().endswith("¬"):
        return False
    stripped = text.replace(".", "").replace(" ", "")
    return lr.width_ratio < _SHORT_LINE_RATIO and stripped.isupper() and len(stripped) >= 2


def _make_merged_lineref(base: "LineRef", other: "LineRef", combined_text: str) -> "LineRef":
    """Return a new LineRef merging two fragments, using the first as anchor."""
    all_pts = base.line_coords + other.line_coords
    xs = [p[0] for p in all_pts]
    ys = [p[1] for p in all_pts]
    merged_coords = [
        [min(xs), min(ys)], [max(xs), min(ys)],
        [max(xs), max(ys)], [min(xs), max(ys)],
    ]
    return LineRef(  # type: ignore[call-arg]  # forward ref resolved at runtime
        page_filename=base.page_filename,
        region_id=base.region_id,
        region_type=base.region_type,
        region_coords=base.region_coords,
        line_id=base.line_id,
        line_coords=merged_coords,
        text=combined_text.strip(),
        has_soft_hyphen=False,
    )


def _try_merge(texts: list[str]) -> str | None:
    """
    Try all orderings and concatenation styles of the given text fragments
    to find one that matches _RE_HEADING. Returns the matching combined text
    or None if no combination works.
    """
    from itertools import permutations
    stripped = [t.rstrip(".").strip() for t in texts]
    # Only try forward (in order) and, for pairs, reverse
    candidates = [" ".join(stripped)]
    if len(stripped) == 2:
        candidates.append(" ".join(reversed(stripped)))
        # Also try direct concatenation (for char-level splits like CONSILI + VM)
        candidates.append(stripped[0] + stripped[1])
        candidates.append(stripped[1] + stripped[0])
    for candidate in candidates:
        if _RE_HEADING.match(candidate + "."):  # add period so regex's \.? matches
            return candidate
    return None


def merge_split_headings(lines: list["LineRef"]) -> list["LineRef"]:
    """
    Pre-processing pass: merge consecutive narrow all-caps lines when together
    they form a valid consilium heading (handles 2- and 3-part splits).
    """
    result: list[LineRef] = []
    i = 0
    while i < len(lines):
        lr = lines[i]
        # Fast path: not a fragment candidate
        if not _is_heading_fragment(lr) or _RE_HEADING.match(lr.text):
            result.append(lr)
            i += 1
            continue

        # Try to extend with 1 or 2 more fragment lines
        merged = None
        for window in range(1, 3):
            if i + window >= len(lines):
                break
            group = lines[i: i + window + 1]
            if not all(_is_heading_fragment(g) for g in group):
                break
            combined = _try_merge([g.text for g in group])
            if combined:
                merged = _make_merged_lineref(group[0], group[-1], combined)
                log.info(
                    "Merged split heading on %s: %s → '%s'",
                    lr.page_filename,
                    [g.text for g in group],
                    combined,
                )
                result.append(merged)
                i += window + 1
                break

        if merged is None:
            result.append(lr)
            i += 1
    return result


def _width_ratio(line_coords: list[list[int]], region_coords: list[list[int]]) -> float:
    rx = [p[0] for p in region_coords]
    lx = [p[0] for p in line_coords]
    rw = max(rx) - min(rx)
    return (max(lx) - min(lx)) / rw if rw else 1.0


# ---------------------------------------------------------------------------
# Line reference (annotated text stream entry)
# ---------------------------------------------------------------------------


@dataclass
class LineRef:
    page_filename: str
    region_id: str
    region_type: str
    region_coords: list[list[int]]
    line_id: str
    line_coords: list[list[int]]
    text: str
    has_soft_hyphen: bool = False

    @property
    def width_ratio(self) -> float:
        return _width_ratio(self.line_coords, self.region_coords)


# ---------------------------------------------------------------------------
# Output data structure
# ---------------------------------------------------------------------------


@dataclass
class RegionSpan:
    page_filename: str
    region_id: str
    region_type: str
    region_coords: list[list[int]]
    first_line_id: str
    last_line_id: str


@dataclass
class Consilium:
    id: str
    n: int
    roman: str
    volume: str
    title: str
    summary: str
    body: list[str]   # sections split at leading † markers
    sources: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "n": self.n,
            "roman": self.roman,
            "volume": self.volume,
            "title": self.title,
            "summary": self.summary,
            "body": self.body,
            "sources": self.sources,
        }


# ---------------------------------------------------------------------------
# Page-stream iterator
# ---------------------------------------------------------------------------

_SKIP_TYPES = {"header"}


def iter_lines(pages: list[PageData]) -> Iterator[LineRef]:
    """Yield all content TextLines across pages in reading order, skipping headers."""
    for page in pages:
        for region in page.regions:
            if region.region_type in _SKIP_TYPES:
                continue
            for line in region.lines:
                if not line.text:
                    continue
                yield LineRef(
                    page_filename=page.filename,
                    region_id=region.region_id,
                    region_type=region.region_type,
                    region_coords=region.coords.to_list(),
                    line_id=line.line_id,
                    line_coords=line.coords.to_list(),
                    text=line.text,
                    has_soft_hyphen=line.has_soft_hyphen,
                )


# ---------------------------------------------------------------------------
# Sequence healing
# ---------------------------------------------------------------------------


def _heal_sequence(consilia: list[Consilium], volume: str) -> list[Consilium]:
    """
    Post-processing: reclassify out-of-sequence consilia to the missing number
    they most likely represent (OCR garbled the numeral to a different valid one).

    For example CXIII (113) appearing between XCI (92) and XCIIII (94) in page
    order is clearly a misread of XCIII (93) → reclassified to n=93.

    Condition for reclassification:
      - The consilium's n is outside the range (prev_n, next_n) in page order
      - There is exactly one missing number in (prev_n, next_n)

    After reclassification the IDs of all consilia are rebuilt so that
    duplicates generated by the original false detection are cleaned up.
    """
    result = list(consilia)
    detected: set[int] = {c.n for c in result if c.n > 0}

    for idx in range(len(result)):
        c = result[idx]

        # Neighbours in page order (skip n=0 entries when looking for neighbours)
        prev_n = next(
            (result[j].n for j in range(idx - 1, -1, -1) if result[j].n > 0),
            0,
        )
        next_n = next(
            (result[j].n for j in range(idx + 1, len(result)) if result[j].n > 0),
            501,
        )

        if c.n == 0:
            # Geometric heading with unknown number: assign if only one number is
            # missing between the two numbered neighbours (e.g. CCSCXXXVIII → n=438)
            if next_n == prev_n + 2 and (prev_n + 1) not in detected:
                correct_n = prev_n + 1
                log.info(
                    "Sequence heal (geo n=0): assign n=%d at %s (neighbours: %d, %d)",
                    correct_n,
                    c.sources[0]["page"] if c.sources else "?",
                    prev_n, next_n,
                )
                detected.add(correct_n)
                c.n = correct_n
            continue

        if prev_n < c.n < next_n:
            continue  # in sequence, nothing to heal

        # Out of sequence: exactly one missing number in (prev_n, next_n)?
        missing_in_range = [
            m for m in range(prev_n + 1, next_n) if m not in detected
        ]
        if len(missing_in_range) != 1:
            continue

        correct_n = missing_in_range[0]
        log.info(
            "Sequence heal: reclassify n=%d → n=%d at %s (neighbours: %d, %d)",
            c.n, correct_n,
            c.sources[0]["page"] if c.sources else "?",
            prev_n, next_n,
        )
        detected.discard(c.n)
        detected.add(correct_n)
        c.n = correct_n

    # Rebuild IDs: the original false-duplicate suffixes (-2, -3) are now stale
    used_ids: dict[str, int] = {}
    unknown_count = 0
    for c in result:
        if c.n > 0:
            base_id = f"consilium-{volume.lower()}-{c.n}"
        else:
            unknown_count += 1
            base_id = f"consilium-{volume.lower()}-unknown-{unknown_count}"
        count = used_ids.get(base_id, 0) + 1
        used_ids[base_id] = count
        c.id = base_id if count == 1 else f"{base_id}-{count}"

    return result


# ---------------------------------------------------------------------------
# Segmenter
# ---------------------------------------------------------------------------


class ConsiliumSegmenter:
    """
    Stateful segmenter that consumes a stream of LineRef objects and
    emits Consilium objects.

    State machine:
      BEFORE → (regex/geometric heading) → SUMMARY
      SUMMARY → (body opener) → BODY
      SUMMARY → (next heading) → SUMMARY  [with warning: empty body]
      BODY → (next heading) → SUMMARY     [flush previous consilium]
    """

    def __init__(self, volume: str, use_lb_model: bool = True):
        self.volume = volume
        self.use_lb_model = use_lb_model
        self._unknown_count = 0
        self._used_ids: dict[str, int] = {}  # base_id → count of times seen
        self._reset_state()

    # ------------------------------------------------------------------
    # Internal state helpers
    # ------------------------------------------------------------------

    def _reset_state(self) -> None:
        self._state: str = "BEFORE"
        self._title: str = ""
        self._roman: str = ""
        self._n: int = 0
        self._n2: int = 0   # secondary number from arabic headings (e.g. "Consilium 473. et 414.")
        self._summary_lines: list[LineRef] = []
        self._body_lines: list[LineRef] = []
        self._spans: list[RegionSpan] = []
        self._current_span: Optional[RegionSpan] = None

    def _start_heading(self, text: str, roman: str, n: int, n2: int = 0) -> None:
        self._title = text
        self._roman = roman
        self._n = n
        self._n2 = n2
        self._summary_lines = []
        self._body_lines = []
        self._spans = []
        self._current_span = None
        self._state = "SUMMARY"

    def _track_span(self, lr: LineRef) -> None:
        """Extend or start a RegionSpan for the current consilium."""
        if (
            self._current_span is None
            or self._current_span.region_id != lr.region_id
            or self._current_span.page_filename != lr.page_filename
        ):
            self._current_span = RegionSpan(
                page_filename=lr.page_filename,
                region_id=lr.region_id,
                region_type=lr.region_type,
                region_coords=lr.region_coords,
                first_line_id=lr.line_id,
                last_line_id=lr.line_id,
            )
            self._spans.append(self._current_span)
        else:
            self._current_span.last_line_id = lr.line_id

    def _assemble(self, line_refs: list[LineRef]) -> str:
        """Join lines into a dehyphenated string for summary.

        Preserves leading numbers that are part of numbered summary items
        (e.g. '1 Executor fideicommissa…') but drops lines that consist
        solely of a marginal number with no content.
        """
        texts = [lr.text for lr in line_refs if not _RE_STANDALONE_NUMBER.match(lr.text.strip())]
        return join_lines(texts, use_model=self.use_lb_model)

    def _build_body_sections(self) -> list[str]:
        """Split body into sections at every † character.

        Groups lines by dagger boundaries first, then calls join_lines on each
        group separately (small batches keep the LB model accurate). Any
        mid-line daggers within a joined group are split afterwards.
        """
        if not self._body_lines:
            return []

        # Group lines: a line that starts with † opens a new section
        groups: list[list[str]] = [[]]
        for lr in self._body_lines:
            text = _strip_leading_number(lr.text)
            if not text.strip():
                continue
            if _RE_DAGGER_LEAD.match(text) and groups[-1]:
                groups.append([])
            groups[-1].append(text)

        sections: list[str] = []
        for group in groups:
            if not group:
                continue
            joined = join_lines(group, use_model=self.use_lb_model)
            # Handle mid-line daggers within an already-joined group
            parts = re.split(r"(?=[††])", joined)
            sections.extend(p.strip() for p in parts if p.strip())

        return sections

    def _build_sources(self) -> list[dict]:
        by_page: dict[str, list[RegionSpan]] = {}
        for span in self._spans:
            by_page.setdefault(span.page_filename, []).append(span)
        return [
            {
                "page": page_fn,
                "regions": [
                    {
                        "region_id": s.region_id,
                        "type": s.region_type,
                        "coords": s.region_coords,
                        "first_line": s.first_line_id,
                        "last_line": s.last_line_id,
                    }
                    for s in spans
                ],
            }
            for page_fn, spans in by_page.items()
        ]

    def _flush(self) -> list[Consilium]:
        if not self._title:
            return []
        if not self._body_lines and not self._summary_lines:
            log.warning("Empty consilium '%s' — skipping.", self._title)
            return []

        if not self._body_lines:
            log.warning(
                "No body found for '%s' (n=%d); storing all content as summary.",
                self._title, self._n,
            )

        base_id = (
            f"consilium-{self.volume.lower()}-{self._n}"
            if self._n > 0
            else self._next_unknown_id()
        )
        cid = self._unique_id(base_id)
        summary = self._assemble(self._summary_lines)
        body = self._build_body_sections()
        sources = self._build_sources()

        c = Consilium(
            id=cid,
            n=self._n,
            roman=self._roman,
            volume=self.volume,
            title=self._title,
            summary=summary,
            body=body,
            sources=sources,
        )

        n2 = self._n2
        self._reset_state()

        result: list[Consilium] = [c]
        if n2 > 0:
            # Emit a second entry for the secondary number in arabic-style headings
            # (e.g. "Consilium 473. et 414." → also create n=414 which heals to n=474)
            clone_base_id = f"consilium-{self.volume.lower()}-{n2}"
            clone = Consilium(
                id=self._unique_id(clone_base_id),
                n=n2,
                roman=str(n2),
                volume=self.volume,
                title=c.title,
                summary=summary,
                body=body[:],
                sources=sources[:],
            )
            result.append(clone)

        return result

    def _next_unknown_id(self) -> str:
        self._unknown_count += 1
        return f"consilium-{self.volume.lower()}-unknown-{self._unknown_count}"

    def _unique_id(self, base_id: str) -> str:
        """Return base_id on first use; append -2, -3, … on duplicates."""
        count = self._used_ids.get(base_id, 0) + 1
        self._used_ids[base_id] = count
        if count == 1:
            return base_id
        log.warning("Duplicate consilium ID '%s' (occurrence %d).", base_id, count)
        return f"{base_id}-{count}"

    # ------------------------------------------------------------------
    # Line classification helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _is_heading(text: str) -> tuple[bool, str, int, int]:
        """Return (matched, roman_or_num_str, primary_n, secondary_n).

        secondary_n is non-zero only for arabic-numeral headings that name two
        consilia (e.g. 'Consilium 473. et 414.').
        """
        m = _RE_HEADING.match(text) or _RE_HEADING.match(_normalize_ocr_e(text))
        if m:
            roman = m.group(1).upper()
            n = roman_to_int(roman) or 0
            return True, roman, n, 0
        m2 = _RE_ARABIC_HEADING.match(text)
        if m2:
            n1 = int(m2.group(1))
            n2 = int(m2.group(2)) if m2.group(2) else 0
            return True, str(n1), n1, n2
        return False, "", 0, 0

    @staticmethod
    def _is_body_opener(text: str) -> bool:
        if _RE_BODY_OPENER.search(text):
            return True
        if _RE_DAGGER_LEAD.match(text):
            return True
        return False

    @staticmethod
    def _looks_like_heading_geometrically(lr: LineRef) -> bool:
        """Narrow, all-caps line not matching a numbered summary item.

        Rejects obvious fragments: lines ending with ¬ (word split mid-line),
        very short strings, or lines that are clearly partial (fewer than 4
        distinct alpha characters).
        """
        text = lr.text
        if text.rstrip().endswith("¬"):
            return False  # fragment of a word split at line end
        stripped = text.replace(".", "").replace(" ", "").replace("¬", "")
        alpha_chars = sum(1 for c in stripped if c.isalpha())
        if alpha_chars < 4:
            return False
        if _RE_PURE_NUMERAL.match(text.strip()):
            return False  # bare numeral fragment (e.g. "CCLXVI.")
        if _RE_WORD_FRAGMENT.match(text.strip()):
            return False  # tail of a split word (e.g. "LIVM CCLIII.")
        if _RE_SECTION_LABEL.match(text.strip()):
            return False  # section label (casus, additio) — belongs to adjacent consilium
        return (
            lr.width_ratio < _SHORT_LINE_RATIO
            and stripped.isupper()
            and len(text) >= 6
            and not _RE_SUMMARY_ITEM.match(text)
        )

    @staticmethod
    def _is_summary_continuation(text: str) -> bool:
        """Line that continues a previous summary item (starts lowercase)."""
        return bool(text) and text[0].islower()

    # ------------------------------------------------------------------
    # Main processing loop
    # ------------------------------------------------------------------

    def process(self, lines: Iterator[LineRef]) -> list[Consilium]:
        # Pre-process: geometry-based colinear merge first, then text-based split-heading merge
        all_lines = _merge_colinear_splits(list(lines))
        all_lines = merge_split_headings(all_lines)
        results: list[Consilium] = []
        # (results populated by the loop below; healed and ID-rebuilt at end)

        for lr in all_lines:
            text = lr.text

            # ── 1. Check for a new consilium heading ──────────────────
            matched, roman, n, n2 = self._is_heading(text)

            if not matched and self._state in ("BODY", "BEFORE"):
                # Geometric fallback only when we expect text (BODY) or
                # haven't found the first heading yet (BEFORE)
                if self._looks_like_heading_geometrically(lr):
                    log.warning(
                        "Geometric heading detected on page %s: '%s'",
                        lr.page_filename, text,
                    )
                    matched, roman, n, n2 = True, "?", 0, 0

            if matched:
                results.extend(self._flush())
                self._start_heading(text, roman, n, n2)
                self._track_span(lr)
                continue

            # ── 2. State machine ──────────────────────────────────────
            if self._state == "BEFORE":
                continue  # skip preamble / ToC lines before first heading

            self._track_span(lr)

            if self._state == "SUMMARY":
                if self._is_body_opener(text):
                    self._state = "BODY"
                    self._body_lines.append(lr)
                elif self._is_summary_continuation(text):
                    # Continuation of a multi-line summary item → append to last item
                    if self._summary_lines:
                        # merge into previous line's text by appending to its list
                        # (we keep as separate LineRef so LB model can process them)
                        self._summary_lines.append(lr)
                    else:
                        # Edge case: continuation before first numbered item
                        self._summary_lines.append(lr)
                else:
                    self._summary_lines.append(lr)

            elif self._state == "BODY":
                self._body_lines.append(lr)

        # Flush the last consilium
        results.extend(self._flush())

        results = _heal_sequence(results, self.volume)
        return results
