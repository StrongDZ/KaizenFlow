// Package agent is the edge-agent runtime: it turns the frames of the video
// pipeline into windowed telemetry, buffers it in SQLite and publishes it
// over MQTT, applies station configs and serves resend requests.
package agent

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"gauge-twin/edge/decode"
)

// MachineRef identifies a machine in the MQTT topic tree.
type MachineRef struct{ Plant, Line, Machine string }

// ParseMachines parses "plant/line/machine,plant/line/machine".
func ParseMachines(list string) ([]MachineRef, error) {
	var out []MachineRef
	for _, item := range strings.Split(list, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		parts := strings.Split(item, "/")
		if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
			return nil, fmt.Errorf("machine %q is not plant/line/machine", item)
		}
		out = append(out, MachineRef{parts[0], parts[1], parts[2]})
	}
	return out, nil
}

// Config of the agent.
type Config struct {
	EdgeID      string
	Machines    []MachineRef // the first one carries the edge status topic
	TopicPrefix string

	ConfigDir string // station configs shared with the pipeline

	Heartbeat  time.Duration
	StaleAfter time.Duration // pipeline silence that triggers FLAG_STALE and a restart
	// StartupGrace replaces StaleAfter until a camera delivered its first
	// frame after a config activation or a pipeline restart.
	StartupGrace   time.Duration
	ReplayRate     float64 // buffered or resent messages per second
	PublishTimeout time.Duration
	ReloadRetry    time.Duration // wait before retrying a failed config reload
	Tick           time.Duration // period of the housekeeping tick
	PruneEvery     time.Duration
	BackoffMin     time.Duration
	BackoffMax     time.Duration

	Decode decode.Options
}

// DefaultConfig returns the defaults of SPEC section 4.3.
func DefaultConfig() Config {
	return Config{
		TopicPrefix:    "denso",
		Heartbeat:      30 * time.Second,
		StaleAfter:     30 * time.Second,
		StartupGrace:   2 * time.Minute,
		ReplayRate:     50,
		PublishTimeout: 10 * time.Second,
		ReloadRetry:    10 * time.Second,
		Tick:           time.Second,
		PruneEvery:     time.Minute,
		BackoffMin:     time.Second,
		BackoffMax:     60 * time.Second,
		Decode:         decode.DefaultOptions(),
	}
}

func (c Config) Validate() error {
	switch {
	case c.EdgeID == "":
		return errors.New("edge id is required")
	case c.ConfigDir == "":
		return errors.New("config directory is required")
	case c.ReplayRate <= 0 || c.Heartbeat <= 0 || c.StaleAfter <= 0 || c.Tick <= 0:
		return errors.New("rates and intervals must be positive")
	}
	seen := map[string]bool{}
	for _, m := range c.Machines {
		if seen[m.Machine] {
			return fmt.Errorf("machine %s listed twice", m.Machine)
		}
		seen[m.Machine] = true
	}
	return nil
}

func (c Config) machineTopic(m MachineRef, kind string) string {
	return strings.Join([]string{c.TopicPrefix, m.Plant, m.Line, m.Machine, kind}, "/")
}

// Status and the last will go to the status topic of the first machine. An
// edge no machine is assigned to yet publishes no status.
func (c Config) statusTopic() string {
	if len(c.Machines) == 0 {
		return ""
	}
	return c.machineTopic(c.Machines[0], "status")
}

// assignmentTopic carries the machines config-api assigns to this edge.
func (c Config) assignmentTopic() string {
	return strings.Join([]string{c.TopicPrefix, "edges", c.EdgeID, "assignment"}, "/")
}

// AssignmentPath is where the last assignment is kept. Not a .json file: the
// pipeline loads every .json of the directory as a station config.
func AssignmentPath(configDir string) string {
	return filepath.Join(configDir, "edge-assignment.pbjson")
}

// Resend requests are per edge, because sequence numbers are per edge.
func (c Config) resendTopic() string {
	if len(c.Machines) == 0 {
		return ""
	}
	return strings.Join([]string{c.TopicPrefix, c.Machines[0].Plant, "edge", c.EdgeID, "cmd", "resend"}, "/")
}

func (c Config) resendAckTopic() string { return c.resendTopic() + "/ack" }
