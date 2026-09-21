# 0091: Time is Server-owned append-only evidence

## Status

Accepted.

## Context

Time sources run on the same system as the Server and can expose sensitive application and window
metadata. Their observations are not Device-authored material and are not a new Sync stream.

## Decision

The Server owns Time source configuration and imported Activity intervals. Intervals are
append-only evidence attributed to their source; Devices read them through Server APIs and do not
store, edit, delete, or Sync them. Source adapters preserve provider evidence for later inspection
while the ordinary Time view uses normalized interval fields.

## Consequences

Time's availability is a Server capability rather than a local-data feature. A Device can hide its
root row without affecting ingestion, retained evidence, or another Device's access.
