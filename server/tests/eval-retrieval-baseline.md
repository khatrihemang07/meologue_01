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
