# Retrieval eval — baseline before the harness redesign

Recorded **2026-08-27**, against commit `706181d` plus issue #90's eval harness and nothing else.
This is the number every later retrieval change is measured against. Reproduce with:

```sh
docker compose up -d --wait postgres-sandbox && ./scripts/seed-sandbox.sh
cd server && cargo test --test eval_retrieval -- --ignored --nocapture
```

## What was measured

`tests/eval_retrieval.rs`, 29 Questions over the seeded Sandbox corpus (119 live Entries), against
the two retrieval arms that exist in the code today:

- **`semantic`** — `reflect.rs::retrieve_nearest`, **with `MIN_SIMILARITY = 0.60` applied**, which is
  the point of this baseline.
- **`date_range`** — `reflect.rs::retrieve_range`.

Word search is not measured because it does not exist on the Server (the FTS5 index is client-side
only). Issue #94 builds it; issue #100 does the three-way comparison that decides embeddings' fate.

Embedding model `harrier-270m` on Ollama, 640-dim, through `llm.rs::embed_query`'s
`Instruct:`/`Query:` template.

## Result

| arm | mean recall | Questions scored | scored exactly 0 |
|---|---|---|---|
| `semantic` | **0.319** | 22 | **7** |
| `date_range` | 1.000 | 4 | 0 |

Cost, deliberately reported apart from the score and never folded into it:

| arm | Questions | steps | total wall-clock | mean |
|---|---|---|---|---|
| `semantic` | 25 | 50 | 107.41s | 4.30s |
| `date_range` | 4 | 8 | 0.72s | 0.18s |

Wall-clock is not a fair reading of the embedding model here: Ollama was degraded during this run
(~25s per embed against roughly 2s earlier the same day, after a load spike drove the machine into
swap). Treat the `semantic` timings as an upper bound, not a measurement.

Token counts are absent because `llm.rs::embed` reads only `data[0].embedding` and never looks at a
`usage` field. Step counts stand in.

## The finding that matters: the score is phrasing-dependent, not topic-dependent

The absent-topic controls were supposed to retrieve nothing. Two did. One did not:

| control Question | Entries above the 0.60 floor |
|---|---|
| "What did I write about my cat?" | 0 |
| "What did I think of the football match?" | 0 |
| **"Did I mention a trip to Japan anywhere?"** | **5 false positives** |

Set that against the same topic asked differently. Probing by hand before this harness existed,
*"how was my trip to Japan"* topped out at **0.125** similarity and returned nothing — while
*"Did I mention a trip to Japan anywhere?"* clears the floor five times over.

The mirror image happens on a topic that *is* in the journal. *"what did I write about Priya's
wedding"* topped out at **0.363** and returned **nothing**; *"Tell me about Priya's wedding."*
retrieves 10 Entries, 8 of them correct.

So the floor does not separate present topics from absent ones. It separates **phrasings**. A
threshold cannot be tuned to fix that, because the quantity it thresholds does not mean the same
thing from one Question to the next. This is the same pathology ADR 0024 recorded when it found "my
cat" (0.691, absent) outscoring "the wedding" (0.638, present), and it is the evidence behind
removing the floor in issue #92.

## Correction to an earlier claim

Issue #90's body and the plan that preceded it both state that three of the seven seeded threads
return **zero** Entries. That was measured with short hand-written probes ("what did I write about
X"), and it is true *of those phrasings*. It is not a general property of the threads: asked in the
eval's fuller wordings, the wedding, mum's-health and books threads all retrieve something.

The honest summary is worse than the original claim rather than better: it is not that certain
topics fail, it is that **any** topic can fail depending on how it is asked. Mean recall 0.319 with
7 of 22 Questions at exactly zero is the number to beat.

## Per-Question detail

```
question                 thread     arm          expected retrieved  hits   recall
knee-arc                 knee       semantic           12         5     2     0.17
knee-onset               knee       semantic            2         6     0     0.00
knee-physio              knee       semantic            5         6     2     0.40
knee-back-running        knee       semantic            3        11     0     0.00
aurora-overview          aurora     semantic           14         4     4     0.29
aurora-cutover-success   aurora     semantic            6         7     1     0.17
aurora-devika            aurora     semantic            8        11     6     0.75
wedding-overview         wedding    semantic           14        10     8     0.57
wedding-hen-do           wedding    semantic            3         7     1     0.33
wedding-day              wedding    semantic            3         3     0     0.00
wedding-day              wedding    date_range          3         3     3     1.00
caffeine-experiment      caffeine   semantic            7         3     1     0.14
caffeine-slip            caffeine   semantic            2        13     2     1.00
books-reading            books      semantic            6         0     0     0.00
books-piranesi-finished  books      semantic            1         2     1     1.00
flat-move-reason         flat-move  semantic            2        13     0     0.00
flat-move-search         flat-move  semantic            5        15     3     0.60
flat-move-day            flat-move  semantic            5        12     3     0.60
flat-move-day            flat-move  date_range          5         5     5     1.00
mum-health-overview      mum-health semantic            6         1     1     0.17
mum-health-results       mum-health semantic            2         0     0     0.00
mum-health-worry         mum-health semantic            2         1     1     0.50
aurora-cutover-days      aurora     semantic            6         7     2     0.33
aurora-cutover-days      aurora     date_range          6         6     6     1.00
knee-physio-week         knee       semantic            6         8     0     0.00
knee-physio-week         knee       date_range          6         6     6     1.00
absent-cat               absent     semantic            0         0     0      n/a
absent-japan             absent     semantic            0         5     0      n/a
absent-football          absent     semantic            0         0     0      n/a
```

Note `date_range` scoring 1.000 on all four of its Questions: retrieval by time is not the broken
part of Reflection, which is why issue #93 keeps it as the harness's first tool.

## The corpus flatters these numbers

ADR 0023 measured `MIN_SIMILARITY = 0.60` separating topics cleanly at ~80 Entries and **failing to
separate them at 572**. The Sandbox corpus holds ~120 live Entries, which sits at the small end of
that range.

So 0.319 mean recall is an **optimistic** reading, not a pessimistic one: on a journal the size a
real user accumulates, semantic retrieval has more neighbours to confuse itself with, not fewer.
Any future tuning of retrieval needs a purpose-built larger corpus before its numbers mean
anything — the 484-Entry Barbellion corpus that would have served was removed when this one
replaced it.

## After #92 — the floor removed

Recorded **2026-08-27**, same day and same seeded Sandbox corpus as the baseline above (not
re-seeded — this is the same 29 Questions against the same ~120 Entries, so the comparison isolates
the code change). Reproduce with the same commands as above, now against `reflect.rs` with
`MIN_SIMILARITY` and its SQL clause deleted (issue #92):

```sh
cd server && cargo test --test eval_retrieval -- --ignored --nocapture
```

### Result — this is a lift, not a null result

| arm | mean recall | Questions scored | scored exactly 0 |
|---|---|---|---|
| `semantic` (before, floor applied) | 0.319 | 22 | 7 |
| `semantic` (after, no floor) | **0.859** | 22 | **0** |
| `date_range` (unchanged either way) | 1.000 | 4 | 0 |

Mean recall on `semantic` **nearly tripled** (0.319 → 0.859), and every one of the 7 Questions that
previously scored exactly zero now scores above zero — none of the 22 scored Questions comes back
empty any more. The acceptance criterion this issue names directly holds: "what did I write about
Priya's wedding" (`wedding-overview`/`wedding-hen-do`/`wedding-day` below) now returns real Entries
where the floor previously returned nothing for that phrasing.

Cost, reported apart from the score as always — and dramatically smaller this run because Ollama
was not degraded this time (the baseline's own caveat about a load-spike-induced slowdown does not
apply here; do not compare the two wall-clock columns to each other):

| arm | Questions | steps | total wall-clock | mean |
|---|---|---|---|---|
| `semantic` | 25 | 50 | 15.17s | 0.61s |
| `date_range` | 4 | 8 | 0.16s | 0.04s |

### Per-Question detail

```
question                 thread     arm          expected retrieved  hits   recall
knee-arc                 knee       semantic           12        40    11     0.92
knee-onset               knee       semantic            2        40     2     1.00
knee-physio              knee       semantic            5        40     4     0.80
knee-back-running        knee       semantic            3        40     2     0.67
aurora-overview          aurora     semantic           14        40    10     0.71
aurora-cutover-success   aurora     semantic            6        40     5     0.83
aurora-devika            aurora     semantic            8        40     8     1.00
wedding-overview         wedding    semantic           14        40    12     0.86
wedding-hen-do           wedding    semantic            3        40     2     0.67
wedding-day              wedding    semantic            3        40     3     1.00
wedding-day              wedding    date_range          3         3     3     1.00
caffeine-experiment      caffeine   semantic            7        40     7     1.00
caffeine-slip            caffeine   semantic            2        40     2     1.00
books-reading            books      semantic            6        40     4     0.67
books-piranesi-finished  books      semantic            1        40     1     1.00
flat-move-reason         flat-move  semantic            2        40     2     1.00
flat-move-search         flat-move  semantic            5        40     5     1.00
flat-move-day            flat-move  semantic            5        40     3     0.60
flat-move-day            flat-move  date_range          5         5     5     1.00
mum-health-overview      mum-health semantic            6        40     6     1.00
mum-health-results       mum-health semantic            2        40     2     1.00
mum-health-worry         mum-health semantic            2        40     2     1.00
aurora-cutover-days      aurora     semantic            6        40     3     0.50
aurora-cutover-days      aurora     date_range          6         6     6     1.00
knee-physio-week         knee       semantic            6        40     4     0.67
knee-physio-week         knee       date_range          6         6     6     1.00
absent-cat               absent     semantic            0        40     0      n/a
absent-japan             absent     semantic            0        40     0      n/a
absent-football          absent     semantic            0        40     0      n/a
```

### What this number does and does not mean

**`retrieved` is now 40 (`RETRIEVAL_LIMIT`) for every `semantic` row, including the absent-topic
controls.** That is the expected, designed-in shape of removing a floor, not a bug in the harness:
`retrieve_nearest` returns its top-k unconditionally now, so every Question — one with a real
thread behind it or one about a topic that has never been written down — gets the same 40
candidates handed to the answering call. Recall went up because the Entries this eval's human
grader already marked correct are, for every scored Question here, somewhere in that top-40; before
this change, a real correct Entry sitting at 0.55 or 0.58 similarity was thrown away before the
chat call ever got a chance to read it.

**This harness measures recall, not precision, and precision is not free.** The three absent-topic
controls each still retrieve 40 Entries — none of them hit the (empty) expected set, so recall is
correctly `n/a`/clean for all three, but all 40 are now handed to the answering call's context on
every Question, present-topic or not. Whether the model actually says "I found nothing about that"
for an absent topic once faced with 40 candidates that merely share a mood or a phrase is
CONTEXT.md's Grounding rule and `docs/adr/0024`'s relevance judgment — this eval harness does not
test that end-to-end behavior; `tests/reflect.rs`'s answering-call tests do, with a mocked chat
client. The trade this issue took deliberately (see its "What to build") is exactly this: more
Entries reach the Answer, some irrelevant, and the model — not a discarded-before-arrival score —
is what has to sort that out now.

**Conclusion: this is the lift the issue asked for, measured against the same corpus as the
baseline.** Mean recall 0.319 → 0.859, zero-scoring Questions 7 → 0, with no regression on
`date_range` (unaffected by this change, still 1.000). This is not a null result.

### What the 0.859 does and does not prove

`retrieve_nearest` now returns `RETRIEVAL_LIMIT` = 40 rows for every Question, out of **119 live
Entries**. Selecting 40 of 119 *at random* would score an expected recall of **≈ 0.336**. So:

- 0.859 is comfortably above chance, which does show the ranking carries real signal.
- But the jump from 0.319 to 0.859 is mostly **"we stopped throwing correct results away"**, not
  "the ranking got better". The ranking did not change at all in #92; only the floor did.

Read the lift as a fix to a bug, not as evidence that semantic search is good. The question of
whether embeddings beat word search is still open and still belongs to #100 — and it must be judged
at a comparable `k`, because recall@40 on a 119-Entry corpus is a generous metric for any arm.

## After #94 — word search enters, as a third arm

Recorded **2026-08-27**, same day and same seeded Sandbox corpus (119 live Entries) as both sections
above, not re-seeded — so all three sections score the same 29 Questions against the same Entries and
the comparison isolates code changes only. Reproduce with:

```sh
cd server && cargo test --test eval_retrieval -- --ignored --nocapture --test-threads=1
```

The new arm is **`word_search`** — `reflect.rs::search_words`, backed by migration
`0007_add_entries_word_search.sql` (a `GENERATED ALWAYS AS (to_tsvector('english', body)) STORED`
column with a GIN index, plus `pg_trgm`). It is capped at `RETRIEVAL_LIMIT` (40), the same `k`
`semantic` uses, deliberately.

### A defect found by running the eval, and fixed before recording the number

The first run of this arm scored **0.281** mean recall with **6 Questions at exactly zero**. That
number was not a measurement of word search; it was a measurement of a bug, and it is recorded here
because the bug is instructive rather than because the number is.

`search_words` had two rungs: `websearch_to_tsquery`, then a `pg_trgm` fallback when that matched
nothing. **`websearch_to_tsquery` ANDs every term of the query together.** So a whole
natural-language question matches nothing at all:

```
'How has my knee injury been progressing over time — is it better or worse than when it started?'
   → 'knee' & 'injuri' & 'progress' & 'time' & 'better' | 'wors' & 'start'   →  0 rows
'knee'                                                                       → 16 rows
```

The graded expected set for that Question is 12 Entries. The trigram rung did not rescue it either:
it compares the *whole* 95-character question against each body with `word_similarity`, which no
single Entry's prose comes close to. `"What have I been reading lately?"` failed the same way — which
is issue #94's own acceptance criterion ("'What books have I been reading' is answered correctly,
where semantic search alone returns noise") failing outright.

Two changes, both in `search_words`:

1. **An OR rung between AND and trigram.** Every lexeme the query reduces to, OR-ed rather than
   ANDed, ranked by the same `ts_rank_cd` rung 1 uses, tried only when AND matched nothing. The
   lexemes come from `to_tsvector('english', $1)` **inside SQL**, so they carry exactly the stemming
   and stop-word removal `body_tsv` was generated with. `ts_rank_cd` is what keeps a deliberately
   broad match set usable: an Entry matching more of the query's terms, and rarer ones, outranks one
   sharing a single common word.
2. **A zero-lexeme guard on the trigram rung.** A second defect, found by the agent implementing the
   first and verified independently: a query that reduces to *no lexemes at all* fell past both
   tsquery rungs and then matched ordinary prose on trigrams alone —
   `word_similarity('the of and', 'Uneventful evening, tea and a book.')` is **0.727**, far above the
   0.3 threshold, purely because "the"/"of"/"and" are common substrings of English. Trigram exists to
   rescue a word that was *written down and mistyped*; a query with no words has nothing to have
   mistyped. Rung 3 now requires `to_tsvector('english', $1) != ''::tsvector`. Misspelling tolerance
   is untouched — `phyiso` stems to itself and still reaches trigram.

### Result

| arm | mean recall | Questions scored | scored exactly 0 |
|---|---|---|---|
| `semantic` (no floor, since #92) | **0.859** | 22 | 0 |
| `word_search` (before the fix above) | 0.281 | 22 | 6 |
| `word_search` (**after**) | **0.748** | 22 | **0** |
| `date_range` | 1.000 | 4 | 0 |

Mean recall is a per-Question average, which weights a 1-Entry Question as heavily as a 14-Entry one.
Pooling every graded Entry instead — and, crucially, reporting **precision** alongside, because the
two arms do not return remotely the same number of rows:

| arm | Qs | expected | rows returned | hits | recall (pooled) | **precision** |
|---|---|---|---|---|---|---|
| `semantic` | 22 | 120 | **880** | 100 | 0.833 | 0.114 |
| `word_search` | 22 | 120 | **469** | 89 | 0.742 | **0.190** |
| `date_range` | 4 | 20 | 20 | 20 | 1.000 | 1.000 |

Selecting rows at random would score a precision of ≈ **0.046** (120 expected Entries spread over 22
Questions against a 119-Entry corpus), so both arms carry real signal; word search carries it about
1.7× more densely.

Cost, reported apart from the score and never folded into it:

| arm | Questions | steps | total wall-clock | mean |
|---|---|---|---|---|
| `semantic` | 25 | 50 | 12.93s | 517.1ms |
| `word_search` | 25 | 25 | **0.19s** | **7.6ms** |
| `date_range` | 4 | 8 | 0.018s | 4.4ms |

Ollama was not degraded during this run, so unlike the original baseline these timings are a real
measurement. `word_search` is **68× faster end to end** and takes **half the steps**, because it makes
no network call at all — there is no query to embed.

Absent-topic controls, where the correct answer is to retrieve nothing:

| arm | rows returned across the 3 controls |
|---|---|
| `semantic` | **120** (40 every time — with the floor gone, its top-k is unconditional) |
| `word_search` | **12** |

### Reading this honestly: neither arm wins, and that is the finding

The handoff into this work asked that if word search wins, it be said plainly. It does not win, and
that is said equally plainly:

- **Semantic still leads on recall** — 0.859 vs 0.748 by Question, 0.833 vs 0.742 pooled. Not by much,
  but consistently.
- **Word search leads on everything else** — 1.7× the precision, on 53% as many rows, 68× faster, with
  no embedding model in the dependency graph, and 10× fewer rows returned for topics that do not exist
  in the journal.

The sharpest way to put it: **word search reaches 89% of semantic's recall while returning barely half
as many rows.** That is the comparable-`k` question this measurement can support, and it is not settled
by these numbers — settling it needs a recall@k *curve* for `semantic` evaluated at the row counts
`word_search` actually returns (mean 21.3, not 40). That curve is issue #100's work, and #100 should
not be decided without it. Recall@40 on a 119-Entry corpus is a generous metric for any arm.

**The two arms fail on different Questions, which is the strongest result here.** Taking a 0.15 recall
gap as a win, semantic wins 7 Questions and word search wins 5, and they are not the same Questions:

```
SEMANTIC wins   aurora-devika          1.00 vs 0.12      WORD wins  aurora-cutover-success 1.00 vs 0.83
                wedding-day            1.00 vs 0.33                 aurora-overview        0.93 vs 0.71
                caffeine-slip          1.00 vs 0.50                 wedding-hen-do         1.00 vs 0.67
                caffeine-experiment    1.00 vs 0.57                 knee-physio            1.00 vs 0.80
                knee-onset             1.00 vs 0.50                 flat-move-day          0.80 vs 0.60
                knee-physio-week       0.67 vs 0.33
                books-reading          0.67 vs 0.50
```

`aurora-devika` is the clearest case for embeddings in the whole corpus: 1.00 against 0.12, because
the Question names a person the relevant Entries mostly refer to obliquely. `wedding-hen-do` is the
clearest case against them. This is exactly the complementarity issue #94 asserted when it kept the
two as **separate tools** rather than merging them into one hybrid retriever — asserted there, measured
here. A merged tool would have averaged these two columns together and hidden it.

### One caveat this eval cannot remove

This arm feeds the **raw Question text** to `search_words`. That is not how the harness uses it: the
model calls `search_entries(query: ...)` with terms it chose, and it can call it again with different
terms when the first comes back thin. So 0.748 is a **floor** for word search in the harness, not an
estimate of it — the OR rung exists precisely because the eval's raw-question input is the hardest
input the tool will ever get. `semantic` has no equivalent headroom, since a longer query is not a
handicap for an embedding.

### Per-Question detail

```
question                 thread     arm          expected retrieved  hits   recall
knee-arc                 knee       semantic           12        40    11     0.92
knee-arc                 knee       word_search        12        38    10     0.83
knee-onset               knee       semantic            2        40     2     1.00
knee-onset               knee       word_search         2        30     1     0.50
knee-physio              knee       semantic            5        40     4     0.80
knee-physio              knee       word_search         5        34     5     1.00
knee-back-running        knee       semantic            3        40     2     0.67
knee-back-running        knee       word_search         3        40     2     0.67
aurora-overview          aurora     semantic           14        40    10     0.71
aurora-overview          aurora     word_search        14        34    13     0.93
aurora-cutover-success   aurora     semantic            6        40     5     0.83
aurora-cutover-success   aurora     word_search         6        16     6     1.00
aurora-devika            aurora     semantic            8        40     8     1.00
aurora-devika            aurora     word_search         8         1     1     0.12
wedding-overview         wedding    semantic           14        40    12     0.86
wedding-overview         wedding    word_search        14        18    12     0.86
wedding-hen-do           wedding    semantic            3        40     2     0.67
wedding-hen-do           wedding    word_search         3        17     3     1.00
wedding-day              wedding    semantic            3        40     3     1.00
wedding-day              wedding    date_range          3         3     3     1.00
wedding-day              wedding    word_search         3         1     1     0.33
caffeine-experiment      caffeine   semantic            7        40     7     1.00
caffeine-experiment      caffeine   word_search         7         6     4     0.57
caffeine-slip            caffeine   semantic            2        40     2     1.00
caffeine-slip            caffeine   word_search         2         9     1     0.50
books-reading            books      semantic            6        40     4     0.67
books-reading            books      word_search         6         5     3     0.50
books-piranesi-finished  books      semantic            1        40     1     1.00
books-piranesi-finished  books      word_search         1         9     1     1.00
flat-move-reason         flat-move  semantic            2        40     2     1.00
flat-move-reason         flat-move  word_search         2        26     2     1.00
flat-move-search         flat-move  semantic            5        40     5     1.00
flat-move-search         flat-move  word_search         5        31     5     1.00
flat-move-day            flat-move  semantic            5        40     3     0.60
flat-move-day            flat-move  date_range          5         5     5     1.00
flat-move-day            flat-move  word_search         5        40     4     0.80
mum-health-overview      mum-health semantic            6        40     6     1.00
mum-health-overview      mum-health word_search         6        11     6     1.00
mum-health-results       mum-health semantic            2        40     2     1.00
mum-health-results       mum-health word_search         2        10     2     1.00
mum-health-worry         mum-health semantic            2        40     2     1.00
mum-health-worry         mum-health word_search         2        14     2     1.00
aurora-cutover-days      aurora     semantic            6        40     3     0.50
aurora-cutover-days      aurora     date_range          6         6     6     1.00
aurora-cutover-days      aurora     word_search         6        39     3     0.50
knee-physio-week         knee       semantic            6        40     4     0.67
knee-physio-week         knee       date_range          6         6     6     1.00
knee-physio-week         knee       word_search         6        40     2     0.33
absent-cat               absent     semantic            0        40     0      n/a
absent-cat               absent     word_search         0         2     0      n/a
absent-japan             absent     semantic            0        40     0      n/a
absent-japan             absent     word_search         0         5     0      n/a
absent-football          absent     semantic            0        40     0      n/a
absent-football          absent     word_search         0         5     0      n/a
```

## After #100 — the recall@k curve, the combined arm, and the decision

Recorded **2026-08-27**, same day, same seeded Sandbox corpus (119 live Entries) as every section
above — not re-seeded, so this section's numbers are directly comparable to the "After #94" section's.
Reproduce with:

```sh
cd server && cargo test --test eval_retrieval -- --ignored --nocapture --test-threads=1
```

### What was measured

The "After #94" section named exactly what was missing: a recall@k curve for `semantic`, evaluated
at the row counts `word_search` actually returns (mean 21.3, not 40), because comparing both arms at
a shared `RETRIEVAL_LIMIT` = 40 cap lets `semantic` use roughly twice the rows `word_search` typically
does and calling that a fair fight.

The curve is built **without a single extra Ollama or Postgres call**. Both `retrieve_nearest` and
`search_words` are deterministically ordered (cosine distance ascending; `ts_rank_cd` descending), and
every rung of `search_words` picks which rung fires by whether it matched *any* rows, never by
`limit` — so the first `k` ids of the run already made at `limit = RETRIEVAL_LIMIT` (40) are exactly
what a fresh call with `limit = k` would have returned. The eval therefore makes the same 25
embedding calls and same three-arm queries it always has, caches every arm's ordered top-40 ids per
Question, and computes every number below by slicing that cache in Rust. This mattered operationally,
not just for tidiness: Ollama has previously degraded badly under repeated embedding load, and a
naive implementation that re-ran `SemanticArm` once per `k` in `[5, 10, 20, 21, 30, 40]` would have
multiplied the embedding calls by 6× for a number the existing run already contains.

`k = 21` is not a round number — it is `word_search`'s own measured mean row count from the "After
#94" run. `k = 40` reproduces the already-recorded recall@40 numbers exactly, which is included
deliberately as a check on this new code rather than as a new finding (see the table below: the
`k = 40` row matches the "After #94" section's numbers to three decimal places).

### Result — the curve

Mean recall (per-Question average), pooled recall (hits over every graded Entry, the shape that
doesn't let a 1-Entry Question and a 14-Entry Question count equally), pooled precision, the mean
rows each arm actually returned at that cap (word search is rank-limited by real matches, so capping
it at `k` does not force it to return `k` rows the way `semantic`'s unconditional top-k does), and
the chance baseline (`k` Entries picked at random out of 119):

| k | arm | mean recall | pooled recall | precision | mean rows | chance |
|---|---|---|---|---|---|---|
| 5 | `semantic` | 0.313 | 0.292 | 0.318 | 5.0 | 0.042 |
| 5 | `word_search` | **0.480** | **0.408** | **0.480** | 4.6 | 0.042 |
| 10 | `semantic` | 0.485 | 0.475 | 0.259 | 10.0 | 0.084 |
| 10 | `word_search` | **0.542** | **0.500** | **0.314** | 8.7 | 0.084 |
| 20 | `semantic` | **0.747** | **0.725** | 0.198 | 20.0 | 0.168 |
| 20 | `word_search` | 0.630 | 0.617 | **0.233** | 14.4 | 0.168 |
| **21** | `semantic` | **0.747** | 0.725 | 0.188 | 21.0 | 0.176 |
| **21** | `word_search` | 0.633 | **0.625** | **0.229** | 14.9 | 0.176 |
| 30 | `semantic` | **0.821** | **0.792** | 0.144 | 30.0 | 0.252 |
| 30 | `word_search` | 0.723 | 0.700 | **0.203** | 18.8 | 0.252 |
| 40 | `semantic` | **0.859** | **0.833** | 0.114 | 40.0 | 0.336 |
| 40 | `word_search` | 0.748 | 0.742 | **0.190** | 21.3 | 0.336 |

(`k = 40` row for each arm matches the "After #94" section's mean/pooled/precision numbers exactly —
this is the same run, just reported alongside the curve rather than the recorded prior number.)

**Two things this table says that the flat recall@40 comparison could not:**

1. **The lead crosses over.** At `k = 5` and `k = 10`, `word_search` leads `semantic` on every column
   — recall, pooled recall, and precision. `semantic` only overtakes at `k ≈ 20` and pulls ahead more
   as `k` grows toward 40. "Which arm is better" is not a fixed property of the two arms; it depends
   on how many rows you're willing to pay for.
2. **At `word_search`'s own natural row count, the two arms are not meaningfully different.**
   `word_search`'s "natural" output — what it actually returns once its own internal ranking runs out
   of real matches, which is the `k = 40` row above (mean 21.3 rows, since it is never forced to pad
   out to 40) — scores mean recall 0.748, pooled 0.742, precision 0.190. `semantic` capped to the same
   ~21-row budget (the `k = 21` row) scores mean recall 0.747, pooled 0.725, precision 0.188. Those are
   the same number inside rounding on mean recall and precision, and `word_search` is **ahead** on
   pooled recall (0.742 vs 0.725) and precision (0.190 vs 0.188) at that shared budget.

### Answering the ticket's first question directly

**"At the row count word search actually uses (~21), does semantic still lead on recall?" — no, not
meaningfully.** The 0.859-vs-0.748 gap that made `semantic` look like the clear winner at `k = 40` is
mostly a row-budget effect: `semantic` was being handed roughly twice the candidates `word_search`
typically returns. Equalize the budget and the gap collapses to within a rounding error on mean
recall, and inverts in `word_search`'s favor on pooled recall and precision. This is the finding the
"After #94" section flagged as unsettled, now settled: **word search alone is not worse than semantic
alone at comparable cost.**

### Per-Question detail at k = 21 — where embeddings still win, and where they don't

```
question                 thread       semantic       word winner
knee-arc                 knee             0.75       0.42 semantic
knee-onset               knee             0.50       0.00 semantic
knee-physio              knee             0.80       0.60 semantic
knee-back-running        knee             0.33       0.67 word
aurora-overview          aurora           0.64       0.79 word
aurora-cutover-success   aurora           0.67       1.00 word
aurora-devika            aurora           1.00       0.12 semantic
wedding-overview         wedding          0.86       0.86 tie
wedding-hen-do           wedding          0.67       1.00 word
wedding-day              wedding          1.00       0.33 semantic
caffeine-experiment      caffeine         0.86       0.57 semantic
caffeine-slip            caffeine         1.00       0.50 semantic
books-reading            books            0.67       0.50 semantic
books-piranesi-finished  books            1.00       1.00 tie
flat-move-reason         flat-move        1.00       0.50 semantic
flat-move-search         flat-move        0.60       0.60 tie
flat-move-day            flat-move        0.60       0.80 word
mum-health-overview      mum-health       0.83       1.00 word
mum-health-results       mum-health       1.00       1.00 tie
mum-health-worry         mum-health       1.00       1.00 tie
aurora-cutover-days      aurora           0.50       0.33 semantic
knee-physio-week         knee             0.17       0.33 word
```

At a shared, comparable-cost `k`: `semantic` wins 10 Questions, `word_search` wins 7, 5 tie. That is
a different tally from the "After #94" section's `k = 40` winners table (which used a ≥0.15-gap
threshold on the uncapped numbers) — both are honest reads of the same underlying data at different
`k`, not a contradiction.

**The Questions embeddings carry that word search cannot**, ranked by the size of the gap at `k = 21`
(the ticket's own acceptance criterion — "if embeddings are kept, the record says which Questions
justify them" — this is that list):

| Question | semantic | word | gap | why |
|---|---|---|---|---|
| `aurora-devika` | 1.00 | 0.12 | **0.88** | Names a person ("Devika") the relevant Entries mostly refer to obliquely — the clearest case for embeddings in the whole corpus, unchanged from the "After #94" section's own finding at k=40. |
| `wedding-day` | 1.00 | 0.33 | 0.67 | Asks about "the wedding day itself" without repeating any of the vocabulary ("ceremony", "reception") the matching Entries actually use. |
| `knee-onset` | 0.50 | 0.00 | 0.50 | "When did I first notice something wrong" paraphrases what the Entries describe as a "twinge," never sharing a lexical stem with the Question. |
| `caffeine-slip` | 1.00 | 0.50 | 0.50 | "Slip up and break the rule" vs. Entries describing a specific 4pm coffee — same gap shape as `knee-onset`. |
| `flat-move-reason` | 1.00 | 0.50 | 0.50 | "Why did I have to move" vs. Entries stating the landlord's reason in different words. |

Everything past this top five is a smaller, more marginal `semantic` win (`knee-arc` +0.33 down to
`aurora-cutover-days`/`books-reading` +0.17) — real, but not the kind of gap that on its own would
justify the dependency. The five above are.

**Where `word_search` wins by a comparable margin** (unchanged in kind from the "After #94" section,
now re-confirmed at the comparable `k`): `knee-back-running`, `aurora-cutover-success`,
`wedding-hen-do` (all +0.33 for word search), `flat-move-day` (+0.20), `mum-health-overview` and
`knee-physio-week` (+0.17 each). These are Questions whose vocabulary already matches the Entries
closely — word search's structural advantage — and where `semantic`'s neighbourhood-based ranking
loses ground to the OR-rung's lexical coverage.

### What a combined arm does

Not a new `RetrievalArm` — a union of the two caches already built above, computed the same way the
curve is (slicing, no new calls). Two budgets:

| budget | mean recall | pooled recall | precision | mean rows | chance |
|---|---|---|---|---|---|
| 11+11 (≈ `word_search`'s natural ~21 rows) | 0.747 | 0.717 | **0.249** | 15.7 | 0.132 |
| 20+20 (each arm at half `RETRIEVAL_LIMIT`) | **0.878** | **0.875** | 0.177 | 27.0 | 0.227 |

Two readings:

- **At a comparable total budget (11+11), the union matches either single arm's own recall using
  fewer rows.** 15.7 rows on average (not 21) reaches mean recall 0.747 — the same figure `semantic`
  alone needs a full 21 rows for, and `word_search`'s own natural output (21.3 rows) needs to reach
  0.748. Precision is meaningfully better than either arm alone at that budget (0.249 vs `semantic`'s
  0.188 or `word_search`'s 0.190 at `k=21`).
- **Given more budget (20+20), the union beats both arms' own top-40 numbers outright.** 27 rows
  reaches mean recall 0.878 / pooled 0.875 — higher than `semantic`'s own top-40 (0.859 / 0.833, using
  40 rows) and far above `word_search`'s top-40 (0.748 / 0.742). This is not an artifact of the two
  arms agreeing with each other: if they mostly retrieved the same Entries, the union would look like
  either arm alone. It looks better than both, which is only possible because the two arms are wrong
  on different Questions — the same complementarity the "After #94" section's two "wins" tables
  showed qualitatively, now showing up as a quantitative lift when the two are actually combined.

Cost for this arm in the harness (which already gives the model both tools, unlike this eval's
separate-arm measurement) would be 3 steps — one embed call, one `semantic` query, one `word_search`
query — reported here, never folded into either recall number above.

### The corpus caveat still applies, more so here

Every number in this section inherits the "After #92" section's caveat: ADR 0023 measured the
0.60-similarity floor separating topics cleanly at ~80 Entries and failing at 572, and this corpus
holds ~120. The comparable-k race between `semantic` and `word_search` came out close on this corpus;
a larger, more topically crowded History gives `semantic`'s nearest-neighbour ranking more confusable
neighbours to rank among, which is exactly the mechanism ADR 0023 already measured degrading. There is
no reason to expect that pressure to fall on `word_search` the same way — lexical matching does not
get noisier just because the corpus has more Entries about other things. If anything, a larger corpus
is more likely to widen `word_search`'s position at comparable `k`, not narrow it.

### One caveat this section inherits, unresolved

The "After #94" section's own caveat still holds unchanged here: this eval feeds the **raw Question
text** to `search_words`, not the self-chosen keywords the harness's model actually issues (its own
live example: asked about Priya's wedding, the model called `search_entries(query: "Priya wedding")`
and got all 5 correct Entries on a Question that scored 0 under the old floor). `word_search`'s
numbers throughout this section, including its lead at low `k`, are a **floor**, not an estimate —
the real harness gives it a more favorable input than this eval ever does. `semantic` has no
equivalent headroom; a longer, more natural-language query is not a handicap for an embedding.

### Decision

**Keep embeddings — not because `semantic` beats `word_search` head-to-head at comparable cost, it
does not, but because of two things this measurement found that a single recall number could not
show:**

1. **A specific, named list of Questions where embeddings carry real signal words cannot reach** —
   `aurora-devika` above all (0.88 gap, a Question naming a person the Entries only refer to
   obliquely), and four more at a 0.50 gap each. This is exactly the bar issue #100 set: "if
   embeddings are kept, the record says which Questions justify them." The table above is that
   record.
2. **A combined arm shows genuine complementary lift that neither arm alone provides**, at a budget
   at or below either arm's own cost (0.878 mean recall from a 27-row union vs. 0.859 from
   `semantic`'s own 40-row top-k). This is the strongest single result in this section: it means the
   two arms are not redundant, which is the actual question issue #94 asked when it kept them as
   separate tools rather than merging them, now answered with a number rather than an intuition.

**Confidence is moderate, not high, and that needs saying plainly rather than rounded up:**

- The comparable-k race is genuinely close — close enough that `word_search` leads outright at low
  `k` and edges `semantic` on pooled recall and precision at `k = 21`. The "After #94" section's
  0.859-vs-0.748 gap, read on its own, overstated how much `semantic` alone is worth; that overstatement
  is now corrected; the correction cuts against embeddings, not for them.
- The corpus is ~120 Entries against a documented degradation point of 572 (ADR 0023) — this is the
  optimistic end of the range for `semantic`, and the close comparable-k race measured here is itself
  measured on that optimistic end. A real History could plausibly erase the gap entirely rather than
  hold it.
- The case for keeping embeddings rests on a short, specific list (five Questions with a clear gap,
  one of them — `aurora-devika` — carrying nearly all the weight) and one combined-arm number, not on
  a broad recall advantage. That is a real basis for a decision, not a strong one.

**This measurement does not by itself justify the current shape of the dependency** — a background
worker, a vector column on every Entry, and a Server that refuses to start Reflection at all without
an embedding model configured. The comparable-k finding above (`word_search` alone is not meaningfully
worse) means an embedding-less deployment losing `semantic` entirely would still retrieve reasonably
well, not fail badly — which is a different, and weaker, dependency than "Reflection requires this
model to exist." That is an observation this measurement supports, not a change this ticket makes:
per its own scope, nothing here is removed, and the worker, the column, and the startup dependency are
left exactly as they are for whoever reviews this record next.
