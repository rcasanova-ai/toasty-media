# Peeps contextual interaction fit

Peeps does not assign people a permanent global value score.

The fit engine answers a narrower question:

> Is Person A worth Person B's scarce time for this specific interaction, right now?

It evaluates both directions independently and only considers a mutual introduction eligible when both sides clear their own preferences and thresholds.

## Inputs

### Subject signals
- topics and current topics
- audience
- guest/network topics
- formats and geography
- social activity
- engagement quality
- guest quality
- trajectory
- freshness
- evidence strength

### Recipient preferences
- interests
- preferred audiences, formats and geographies
- excluded topics and formats
- required topics
- minimum evidence strength
- minimum interaction-fit threshold

### Interaction context
- topic
- format
- audience and geography
- intent
- requested time
- urgency
- compensation fit
- intent alignment

## Output

The engine returns:
- contextual score 0 to 100
- eligible true/false
- recipient threshold
- hard conflicts
- transparent component scores
- machine-readable reasons
- human-readable explanation

## Hard exclusions

Explicit recipient exclusions override social prominence, follower count, guest quality, or other glitter.

Example: a large crypto podcast is still ineligible for a person who has explicitly excluded crypto.

## Mutual fit

Use `scoreMutualFit()` to evaluate both directions. A strong A to B score cannot override a failed B to A preference check.

## Next integration points

1. candidate discovery: rank candidates contextually instead of globally
2. request page: show "why this person" and material conflicts
3. authorization: prevent outreach when a hard preference conflict exists
4. Dubs/Breadcrumbs: feed evidence and learned preferences into future evaluations
5. Dough: support recipient-defined minimum-fit gates before paid introductions
6. Santati: consume the same primitive for contextual introductions without importing Peeps UI or payments
