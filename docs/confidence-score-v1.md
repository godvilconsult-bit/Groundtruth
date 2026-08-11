# Confidence Score — `confidence@1.0`

- **Status:** Published
- **Effective:** 2026-08-11
- **Implemented by:** `packages/domain/src/confidence.ts`
- **Superseded by:** —

This document is a **published contract**. Customers licensing the dataset receive a
`confidence_score` on every feature, and this is the definition of that number. It is
versioned; changing any constant means publishing `confidence@1.1`, not editing this
page. Historical scores remain interpretable under the version that produced them.

## Definition

For a feature with at least one contributing observation:

```
score = clamp(evidence × accuracy × recency × resurvey, 0, 1)
```

rounded to three decimal places (the database column is `numeric(4,3)`).

A feature with no contributing observations scores **0**.

### evidence — how many independent people saw it, and who they were

```
weight   = Σ clamp(collector_quality_score, 0, 1)   over DISTINCT collectors
evidence = 1 − e^(−0.9 × weight)
```

One collector is one opinion regardless of how many times they visited. Three visits
by the same mapper contribute their reputation once.

| Independent collectors (each at reputation 1.0) | evidence |
| --- | --- |
| 1 | 0.593 |
| 2 | 0.835 |
| 3 | 0.933 |
| 5 | 0.989 |

**Why saturating rather than linear.** The tenth independent observation of a
building tells you far less than the second. Linear growth would also let volume
substitute for quality — precisely the incentive we design against elsewhere by
paying per acceptance rather than per submission.

### accuracy — how good was the GPS fix

Uses the **best** (lowest) reported accuracy among contributing observations.

```
accuracy = 1.0                                    when acc ≤ 5 m
         = 0.3                                    when acc ≥ 50 m
         = 1 − ((acc − 5) / 45) × 0.7             in between
```

Linear, because it must be explainable to a customer in one sentence. The floor is
0.3 rather than 0: a coarse fix is weaker evidence, not absent evidence.

### recency — how long since anyone checked

```
recency = max(0.4, 0.5 ^ (days_since_last_verified / 540))
```

A half-life of 540 days (18 months), floored at 0.4. Places change; an unverified
observation weakens. The floor reflects that a well-attested feature does not become
worthless merely because it is old.

### resurvey — did an independent mapper agree

| Situation | factor |
| --- | --- |
| Never re-surveyed | 1.0 |
| Re-surveyed, agreed | 1.1 |
| Re-surveyed, disagreed | 0.5 |

Independent re-survey is the strongest signal available, because it is the only stage
that catches a collector reporting plausible values without observing them — a
failure mode invisible to every automated check, since the data is internally
consistent. See RISKS.md R-007.

The 1.1 bonus can push the product above 1.0; the final clamp handles that. It is a
bonus on an already-strong score, not a route past the cap.

## Worked examples

| Scenario | evidence | accuracy | recency | resurvey | **score** |
| --- | --- | --- | --- | --- | --- |
| One proven mapper, good fix, fresh | 0.593 | 1.00 | 1.00 | 1.0 | **0.593** |
| Two proven mappers, good fix, fresh | 0.835 | 1.00 | 1.00 | 1.0 | **0.835** |
| One trainee (0.5), good fix, fresh | 0.362 | 1.00 | 1.00 | 1.0 | **0.362** |
| One proven mapper, 50 m fix | 0.593 | 0.30 | 1.00 | 1.0 | **0.178** |
| One proven mapper, 18 months stale | 0.593 | 1.00 | 0.50 | 1.0 | **0.297** |
| One proven mapper, re-survey disagreed | 0.593 | 1.00 | 1.00 | 0.5 | **0.297** |

These six rows are pinned as regression tests in `confidence.test.ts`. A change to any
constant fails those tests, which is the intended tripwire: the question then is not
"fix the test" but "did we mean to publish a new version?"

## What this score is not

- **Not a probability.** It does not claim the feature is correct with probability
  0.593. It is a comparable ordinal measure of evidential strength under a stated
  formula.
- **Not a substitute for the disagreement rate.** The published accuracy metric is
  the independent re-survey disagreement rate, measured empirically. Confidence is a
  per-feature estimate; disagreement rate is a measured property of the dataset.
- **Not a determination about land.** A high-confidence building footprint is a
  well-attested statement about a structure's extent. It carries no determination of
  any right or interest in land.

## Change process

1. Changes are published as a new version (`confidence@1.1`, `confidence@2.0`), never
   as an edit here.
2. Minor: constants retuned, curve shape unchanged. Major: inputs added or removed,
   or a factor's meaning changed.
3. Existing features keep their stored score until re-scored. `feature.attributes`
   records the formula version that produced the stored value.
4. Customers on a delta feed are notified before a re-score, because a fleet-wide
   confidence shift is indistinguishable from a data change on their side.
