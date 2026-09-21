# 0092: A Time day is the Server's calendar date

## Status

Accepted.

Extends [0091](0091-time-is-server-owned-append-only-evidence.md), and settles a question
[0090](0090-time-is-the-sixth-root-destination.md) left open.

## Context

Time's daily view asks for a calendar date. Which instants that date covers has three possible
answers: the Device's own timezone, UTC, or the Server's configured one.

The first makes the same date mean different things on two Devices, so the same day's evidence
would differ depending on which one was in hand. The second is what the first implementation did,
and it is wrong by a measurable amount rather than in principle: on a Server configured for
Asia/Kolkata holding 7089 imported Activity intervals, the date 2026-09-20 selected 104 intervals
as a UTC day and 70 as a Server-timezone day.

## Decision

A day is the calendar date as the Server's configured timezone (`MEOLOGUE_TZ`, ADR 0027) reckons
it. The Server resolves that zone once at startup and answers every daily query against it, so two
Devices in different zones asking for the same date get the same day.

A day runs from one local midnight to the next local midnight, not for twenty-four hours: a
daylight-saving day is 23 or 25 hours long, and a zone that moves its clocks *at* midnight has a
date whose local midnight never happened, which begins instead at the instant the clock jumped to.
Consecutive days meet exactly, so no recorded activity falls between two days or appears on both.

Devices still send a floating `YYYY-MM-DD` and lay the returned records out against their own local
midnight. That is a rendering choice about where on a page an instant is drawn, and it never
decides which records belong to the day.

## Consequences

Time is consistent across Devices, and a Server in a zone far from UTC stops showing a day that
begins in the middle of the afternoon. Activity recorded around midnight belongs to the day the
Server says it does, which may not be the day the Device's own clock would have chosen — that
disagreement is the point, not a defect.
