# 0090: Time is the sixth root Destination

## Status

Accepted.

Supersedes the five-Destination ceiling stated by [0036](0036-the-shell-is-a-chat-list-and-a-thread-is-a-chat-thread.md)
and [0049](0049-todo-is-the-first-destination-with-internal-navigation.md).

## Context

The root screen could reach Composer, Reflection, Digest, Todo, and Settings. Activity recording
does not fit any of those: it is neither user-authored History nor a Task, and it needs its own
direct address and its own empty state.

## Decision

Time is the sixth root Destination, at `/time`, after Todo and before Settings. It is included in
the Device-local Destination visibility setting; Settings remains the only unhideable recovery
route. It is lazy-loaded under the existing store-owning layout so normal Device Sync continues
while Time is open.

Time requires a Server that explicitly reports the `time` capability. An unset Server URL and an
older Server that omits the capability both lock the root row; a current Server with no enabled
sources opens Time's Settings-linked empty state instead.

## Consequences

The root list has six rows. Older Servers remain usable for their existing Destinations, but Time
does not make a false claim of availability until the Server has explicitly adopted it.
