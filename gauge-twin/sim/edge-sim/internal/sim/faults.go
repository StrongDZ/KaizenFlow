package sim

import (
	"fmt"
	"math/rand"
	"sort"
	"strings"
	"time"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

// Fault is a kind of injected misbehaviour.
type Fault string

const (
	FaultNone       Fault = ""
	FaultOutOfRange Fault = "out_of_range" // a value far outside the gauge range
	FaultBadSchema  Fault = "bad_schema"   // payload that is not a Telemetry message
	FaultDuplicate  Fault = "duplicate"    // the same message published twice
	FaultClockSkew  Fault = "clock_skew"   // window timestamps off by more than 5 minutes
	FaultDisconnect Fault = "disconnect"   // the edge loses its connection for a while
	// FaultGap skips the publish of a message but still uses up its sequence
	// number and keeps the message for resend: a loss after the PUBACK.
	FaultGap Fault = "gap"
)

var allFaults = []Fault{FaultOutOfRange, FaultBadSchema, FaultDuplicate, FaultClockSkew, FaultDisconnect, FaultGap}

// badSchemaPayload announces a 255-byte field and then ends, so it can never
// decode as a protobuf message.
var badSchemaPayload = []byte{0x0A, 0xFF, 0x01, 0xDE, 0xAD}

// FaultSet is the set of enabled faults.
type FaultSet map[Fault]bool

// ParseFaults parses a comma-separated list such as "duplicate,disconnect".
func ParseFaults(list string) (FaultSet, error) {
	set := FaultSet{}
	for _, name := range strings.Split(list, ",") {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		known := false
		for _, f := range allFaults {
			if Fault(name) == f {
				known = true
			}
		}
		if !known {
			return nil, fmt.Errorf("unknown fault %q (valid: %s)", name, FaultSet{}.all())
		}
		set[Fault(name)] = true
	}
	return set, nil
}

func (FaultSet) all() string {
	names := make([]string, len(allFaults))
	for i, f := range allFaults {
		names[i] = string(f)
	}
	return strings.Join(names, ", ")
}

func (s FaultSet) Has(f Fault) bool { return s[f] }

func (s FaultSet) String() string {
	names := make([]string, 0, len(s))
	for f := range s {
		names = append(names, string(f))
	}
	sort.Strings(names)
	return strings.Join(names, ",")
}

// perMessage lists the enabled faults that apply to a single message.
func (s FaultSet) perMessage() []Fault {
	var out []Fault
	for _, f := range allFaults {
		if f != FaultDisconnect && s[f] {
			out = append(out, f)
		}
	}
	return out
}

// pickFault decides whether the next message carries a fault.
func pickFault(candidates []Fault, rate float64, rng *rand.Rand) Fault {
	if len(candidates) == 0 || rng.Float64() >= rate {
		return FaultNone
	}
	return candidates[rng.Intn(len(candidates))]
}

// applyOutOfRange pushes the first readable measurement far out of range.
func applyOutOfRange(t *gaugev1.Telemetry) {
	for _, m := range t.GetMeasurements() {
		if m.Value != nil {
			v := m.GetValue()*10 + 10000
			m.Value, m.VMin, m.VMax = &v, v, v
			return
		}
	}
}

// applyClockSkew moves the window 6 to 15 minutes into the past or future.
// The shift is never a multiple of the window, so a skewed message cannot
// collide with the (machine, gauge, ts) key of a genuine window.
func applyClockSkew(t *gaugev1.Telemetry, window time.Duration, rng *rand.Rand) {
	skew := int64(6*time.Minute/time.Millisecond) + rng.Int63n(int64(9*time.Minute/time.Millisecond))
	if skew%window.Milliseconds() == 0 {
		skew++
	}
	if rng.Intn(2) == 0 {
		skew = -skew
	}
	t.WindowStartMs += skew
	t.WindowEndMs += skew
}
