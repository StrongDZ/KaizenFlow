// Package sim simulates a fleet of edge agents publishing gauge telemetry
// over MQTT: correct schema, per-edge sequence numbers, heartbeats, offline
// buffering with rate-limited replay, reconnect backoff and fault injection.
package sim

import (
	"errors"
	"fmt"
	"time"
)

// Config holds every knob of a simulation run.
type Config struct {
	// Machines is the total number of simulated machines.
	Machines int
	// MachinesPerEdge is how many machines share one edge (one MQTT connection).
	MachinesPerEdge int
	// Window is the aggregation window; each machine sends one message per window.
	Window time.Duration
	// Duration of the run; 0 means until the context is cancelled.
	Duration time.Duration

	Faults    FaultSet
	FaultRate float64 // probability that a message carries a per-message fault
	// DisconnectEvery is the mean time between simulated network cuts of an
	// edge and DisconnectFor how long each cut lasts (fault "disconnect").
	DisconnectEvery time.Duration
	DisconnectFor   time.Duration

	Plant      string
	Heartbeat  time.Duration
	BufferMax  int     // offline buffer capacity per edge, in messages
	ReplayRate float64 // replayed messages per second per edge
	BackoffMin time.Duration
	BackoffMax time.Duration
	// Ramp spreads the initial connections over this period.
	Ramp           time.Duration
	PublishTimeout time.Duration
	// DrainTimeout bounds the time spent flushing buffers on shutdown.
	DrainTimeout time.Duration
	Seed         int64

	// Offset is the index of the first machine, so that several edge-sim
	// instances can simulate disjoint parts of one fleet. It must be a
	// multiple of MachinesPerEdge.
	Offset int
	// Resend makes the edges answer cmd/resend requests from the server; they
	// then keep their last ResendKeep messages in memory.
	Resend     bool
	ResendKeep int
	// Linger keeps the edges connected for this long after Duration without
	// producing new messages, so late resend requests are still answered.
	Linger time.Duration
	// produceUntil is set by Run when Linger is used.
	produceUntil time.Time
}

// DefaultConfig returns the defaults of SPEC section 4.3.
func DefaultConfig() Config {
	return Config{
		Machines:        1,
		MachinesPerEdge: 1,
		Window:          time.Second,
		FaultRate:       0.05,
		DisconnectEvery: 2 * time.Minute,
		DisconnectFor:   15 * time.Second,
		Plant:           "SIM",
		Heartbeat:       30 * time.Second,
		BufferMax:       10000,
		ReplayRate:      50,
		BackoffMin:      time.Second,
		BackoffMax:      60 * time.Second,
		Ramp:            10 * time.Second,
		PublishTimeout:  10 * time.Second,
		DrainTimeout:    15 * time.Second,
		Seed:            1,
		ResendKeep:      20000,
	}
}

// Validate reports the first invalid setting.
func (c Config) Validate() error {
	switch {
	case c.Machines < 1:
		return errors.New("machines must be at least 1")
	case c.MachinesPerEdge < 1:
		return errors.New("machines-per-edge must be at least 1")
	case c.Window < 10*time.Millisecond:
		return errors.New("window must be at least 10ms")
	case c.Duration < 0:
		return errors.New("duration must not be negative")
	case c.FaultRate < 0 || c.FaultRate > 1:
		return errors.New("fault-rate must be between 0 and 1")
	case c.Faults.Has(FaultDisconnect) && (c.DisconnectEvery <= 0 || c.DisconnectFor <= 0):
		return errors.New("disconnect-every and disconnect-for must be positive")
	case c.Heartbeat <= 0:
		return errors.New("heartbeat must be positive")
	case c.BufferMax < 1:
		return errors.New("buffer-max must be at least 1")
	case c.ReplayRate <= 0:
		return errors.New("replay-rate must be positive")
	case c.BackoffMin <= 0 || c.BackoffMax < c.BackoffMin:
		return errors.New("backoff range is invalid")
	case c.PublishTimeout <= 0:
		return errors.New("publish-timeout must be positive")
	case c.Plant == "":
		return errors.New("plant must not be empty")
	case c.Offset < 0 || c.Offset%c.MachinesPerEdge != 0:
		return errors.New("offset must be a non-negative multiple of machines-per-edge")
	case c.Resend && c.ResendKeep < 1:
		return errors.New("resend-keep must be at least 1")
	}
	return nil
}

// Edges is the number of MQTT connections of the run.
func (c Config) Edges() int {
	return (c.Machines + c.MachinesPerEdge - 1) / c.MachinesPerEdge
}

// EdgeID names an edge; sequence numbers are counted per edge.
func EdgeID(edge int) string { return fmt.Sprintf("edge-%04d", edge+1) }

// MachineID names a machine, matching the gauge renderer and the RTSP paths.
func MachineID(machine int) string { return fmt.Sprintf("machine_%03d", machine+1) }

// TopicPrefix is denso/{plant}/{line}/{machine}; ten machines share a line.
func (c Config) TopicPrefix(machine int) string {
	return fmt.Sprintf("denso/%s/L%02d/%s", c.Plant, machine/10+1, MachineID(machine))
}
