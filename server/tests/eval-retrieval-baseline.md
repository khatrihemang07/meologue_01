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
