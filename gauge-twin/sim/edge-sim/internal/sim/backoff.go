package sim

import (
	"math/rand"
	"time"
)

// Backoff yields exponentially growing reconnect delays (min, 2*min, ... up
// to max), each multiplied by a random factor in [0.5, 1.5).
type Backoff struct {
	min, max time.Duration
	attempt  int
	rng      *rand.Rand
}

func NewBackoff(min, max time.Duration, rng *rand.Rand) *Backoff {
	return &Backoff{min: min, max: max, rng: rng}
}

// Next returns the delay before the next attempt.
func (b *Backoff) Next() time.Duration {
	base := b.max
	// The shift is capped so it cannot overflow before the comparison.
	if b.attempt < 32 {
		if d := b.min << uint(b.attempt); d > 0 && d < b.max {
			base = d
		}
	}
	b.attempt++
	return time.Duration(float64(base) * (0.5 + b.rng.Float64()))
}

// Reset is called after a successful connection.
func (b *Backoff) Reset() { b.attempt = 0 }
