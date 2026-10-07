# Cache cleanup policy

Type: grilling
Status: open
Blocked by: 01

## Question

How does cache decide what to evict and when?
- RAM budget and when it spills to disk
- TTL vs LRU vs end-of-session wipe
- per-session vs shared across sessions
- whether anything can be promoted from cache into a comb, and how
