package agent

import (
	"errors"
	"fmt"
	"os"

	"google.golang.org/protobuf/encoding/protojson"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

// ParseAssignment reads an EdgeAssignment (protojson) meant for edgeID.
func ParseAssignment(payload []byte, edgeID string) ([]MachineRef, error) {
	var as gaugev1.EdgeAssignment
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(payload, &as); err != nil {
		return nil, fmt.Errorf("decode assignment: %w", err)
	}
	if as.GetEdgeId() != edgeID {
		return nil, fmt.Errorf("assignment is for edge %q", as.GetEdgeId())
	}
	refs := make([]MachineRef, 0, len(as.GetMachines()))
	seen := map[string]bool{}
	for _, m := range as.GetMachines() {
		if m.GetPlant() == "" || m.GetLine() == "" || m.GetMachineId() == "" {
			return nil, errors.New("every machine needs plant, line and machine_id")
		}
		if seen[m.GetMachineId()] {
			return nil, fmt.Errorf("machine %s listed twice", m.GetMachineId())
		}
		seen[m.GetMachineId()] = true
		refs = append(refs, MachineRef{m.GetPlant(), m.GetLine(), m.GetMachineId()})
	}
	return refs, nil
}

// StoredAssignment is the last assignment the edge received, or nothing.
func StoredAssignment(configDir, edgeID string) ([]MachineRef, error) {
	payload, err := os.ReadFile(AssignmentPath(configDir))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return ParseAssignment(payload, edgeID)
}
