package validate_test

import (
	"strings"
	"testing"

	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/testfix"
	"github.com/kaizenflow/api/internal/validate"
)

func issues(g *store.Graph) []validate.Issue {
	return validate.New().Graph(g, testfix.Types())
}

func hasIssue(t *testing.T, list []validate.Issue, key, contains string) {
	t.Helper()
	for _, i := range list {
		if i.Key == key && strings.Contains(i.Message, contains) {
			return
		}
	}
	t.Fatalf("no issue %s~%q in %v", key, contains, list)
}

func proc(key, in, out string) store.GraphNode {
	return store.GraphNode{Key: key, NodeType: "PACKING", Archetype: "PROCESS", Params: map[string]any{
		"recipes": []any{map[string]any{"inputs": []any{map[string]any{"material": in, "qty": 1.0}},
			"outputs": []any{map[string]any{"material": out, "qty": 1.0}}}}}}
}

func TestMiniGraphIsValid(t *testing.T) {
	if got := issues(testfix.MiniGraph()); len(got) != 0 {
		t.Fatalf("issues = %v", got)
	}
}

func TestSchemaViolation(t *testing.T) {
	g := testfix.MiniGraph()
	g.Nodes[1].Params = map[string]any{"capacity": -1.0}
	hasIssue(t, issues(g), "S", "capacity")
}

func TestNeedsSourceAndSink(t *testing.T) {
	g := testfix.MiniGraph()
	g.Nodes = g.Nodes[1:2]
	g.Edges = nil
	list := issues(g)
	hasIssue(t, list, "model", "SOURCE")
	hasIssue(t, list, "model", "SINK")
}

func TestPoolRules(t *testing.T) {
	g := testfix.MiniGraph()
	g.Edges = append(g.Edges, store.GraphEdge{Key: "S>TUG", Src: "S", Dst: "TUG", Material: "RAW-01", Params: map[string]any{}})
	hasIssue(t, issues(g), "S>TUG", "RESOURCE_POOL")

	g = testfix.MiniGraph()
	g.Edges[1].Params = map[string]any{"mode": "POOL", "pool": "NOPE"}
	hasIssue(t, issues(g), "S>OUT", "pool")

	g = testfix.MiniGraph()
	g.Edges[1].Params = map[string]any{"mode": "POOL", "pool": "TUG", "hook_pool": "TUG"}
	hasIssue(t, issues(g), "S>OUT", "OPERATOR")
}

func TestProcessInputNeedsSupplyingEdge(t *testing.T) {
	g := testfix.MiniGraph()
	g.Nodes = append(g.Nodes, proc("P", "PART", "BOX"))
	hasIssue(t, issues(g), "P", "PART")
}

func TestCycleWithoutStorage(t *testing.T) {
	g := testfix.MiniGraph()
	g.Nodes = append(g.Nodes, proc("P1", "X", "X"), proc("P2", "X", "X"))
	g.Edges = append(g.Edges,
		store.GraphEdge{Key: "P1>P2", Src: "P1", Dst: "P2", Material: "X", Params: map[string]any{}},
		store.GraphEdge{Key: "P2>P1", Src: "P2", Dst: "P1", Material: "X", Params: map[string]any{}})
	hasIssue(t, issues(g), "P1", "cycle")
}
