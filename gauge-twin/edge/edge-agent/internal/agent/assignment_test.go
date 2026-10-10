package agent

import (
	"os"
	"path/filepath"
	"testing"

	gaugev1 "gauge-twin/gen/go/denso/gauge/v1"
)

const assignmentTopic = "denso/edges/edge-7/assignment"

func assignment(machines ...string) []byte {
	out := `{"edge_id": "edge-7", "machines": [`
	for i, m := range machines {
		if i > 0 {
			out += ","
		}
		out += `{"plant": "DENSO_HN", "line": "L03", "machine_id": "` + m + `"}`
	}
	return []byte(out + "]}")
}

func subscribedTo(h *harness, topic string) bool {
	h.broker.mu.Lock()
	defer h.broker.mu.Unlock()
	for i := len(h.broker.sessions) - 1; i >= 0; i-- {
		s := h.broker.sessions[i]
		select {
		case <-s.done:
			continue
		default:
		}
		for _, t := range s.topics {
			if t == topic {
				return true
			}
		}
		return false
	}
	return false
}

// An edge started without machines waits for config-api, follows the
// machines it is given, keeps the list for its next start and forgets a
// machine taken away from it.
func TestEdgeFollowsItsAssignment(t *testing.T) {
	dir := t.TempDir()
	h := newHarness(t, dir, func(c *Config) { c.Machines = nil })
	h.start()
	h.eventually("assignment subscription", func() bool { return subscribedTo(h, assignmentTopic) })
	if len(h.statuses()) != 0 {
		t.Fatal("an edge without machines published a status")
	}

	h.eventually("assignment delivered", func() bool { return h.broker.inject(assignmentTopic, assignment("PRESS_01")) })
	h.eventually("config topic of the assigned machine", func() bool { return subscribedTo(h, configTopic) })
	h.configure("7")
	h.eventually("status of the edge", func() bool {
		st := h.statuses()
		return len(st) > 0 && len(st[len(st)-1].GetMachineIds()) == 1
	})
	stored, err := StoredAssignment(h.cfg.ConfigDir, "edge-7")
	if err != nil || len(stored) != 1 || stored[0].Machine != "PRESS_01" {
		t.Fatalf("stored assignment: %v, %v", stored, err)
	}

	// A second machine is added: the first keeps its config.
	h.eventually("second assignment delivered", func() bool { return h.broker.inject(assignmentTopic, assignment("PRESS_01", "PRESS_02")) })
	h.eventually("config topic of the second machine", func() bool {
		return subscribedTo(h, "denso/DENSO_HN/L03/PRESS_02/config") && subscribedTo(h, configTopic)
	})

	// The first is taken away: its stored config goes, the pipeline restarts to forget it.
	restarts := h.pipeline.count(gaugev1.CommandType_COMMAND_TYPE_RESTART)
	h.eventually("third assignment delivered", func() bool { return h.broker.inject(assignmentTopic, assignment("PRESS_02")) })
	h.eventually("the removed machine is unsubscribed", func() bool {
		return subscribedTo(h, "denso/DENSO_HN/L03/PRESS_02/config") && !subscribedTo(h, configTopic)
	})
	if _, err := os.Stat(filepath.Join(h.cfg.ConfigDir, "PRESS_01.json")); !os.IsNotExist(err) {
		t.Errorf("config of the removed machine still stored: %v", err)
	}
	h.eventually("pipeline restart", func() bool { return h.pipeline.count(gaugev1.CommandType_COMMAND_TYPE_RESTART) == restarts+1 })
}

func TestParseAssignment(t *testing.T) {
	if _, err := ParseAssignment(assignment("A"), "edge-8"); err == nil {
		t.Error("an assignment for another edge was accepted")
	}
	if _, err := ParseAssignment([]byte(`{"edge_id": "edge-7", "machines": [{"plant": "P", "machine_id": "A"}]}`), "edge-7"); err == nil {
		t.Error("a machine without line was accepted")
	}
	if _, err := ParseAssignment(assignment("A", "A"), "edge-7"); err == nil {
		t.Error("a machine listed twice was accepted")
	}
	if refs, err := ParseAssignment(assignment(), "edge-7"); err != nil || len(refs) != 0 {
		t.Errorf("empty assignment: %v %v", refs, err)
	}
	if refs, err := StoredAssignment(t.TempDir(), "edge-7"); err != nil || refs != nil {
		t.Errorf("no stored assignment: %v %v", refs, err)
	}
}
