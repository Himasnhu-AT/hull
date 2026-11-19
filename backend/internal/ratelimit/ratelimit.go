// Package ratelimit is a small in-memory token bucket keyed by string (the client IP).
package ratelimit

import (
	"sync"
	"time"
)

type bucket struct {
	tokens float64
	last   time.Time
}

// Limiter allows burst requests at once and refills perMinute tokens each minute.
type Limiter struct {
	mu      sync.Mutex
	burst   float64
	perSec  float64
	buckets map[string]*bucket
	Now     func() time.Time
}

func New(perMinute int) *Limiter {
	return &Limiter{burst: float64(perMinute), perSec: float64(perMinute) / 60, buckets: map[string]*bucket{}, Now: time.Now}
}

// Allow takes one token for key and reports whether one was available.
func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.Now()
	if len(l.buckets) > 10000 {
		// Full buckets carry no information, so dropping them bounds memory without loosening any limit.
		for k, b := range l.buckets {
			if b.tokens+now.Sub(b.last).Seconds()*l.perSec >= l.burst {
				delete(l.buckets, k)
			}
		}
	}
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	b.tokens += now.Sub(b.last).Seconds() * l.perSec
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
