package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"

	"github.com/kaizenflow/api/internal/store"
)

func TestWriteErrMapsWriteProtocolErrors(t *testing.T) {
	cases := []struct {
		name string
		err  error
		code int
		key  string
	}{
		{"busy", store.ErrBusy, 409, "error"},
		{"changed", store.ErrChanged, 409, "error"},
		{"locked", &store.LockedError{Msg: "đã khoá", Usage: map[string]int{"runs": 1}}, 409, "usage"},
		{"impact", &store.ImpactError{Impact: map[string]int{"runs": 2}}, 409, "impact"},
		{"wrapped impact", fmt.Errorf("delete: %w", &store.ImpactError{Impact: map[string]int{"runs": 2}}), 409, "impact"},
		{"missing", store.ErrNotFound, 404, "error"},
	}
	for _, c := range cases {
		w := httptest.NewRecorder()
		writeErr(w, c.err)
		if w.Code != c.code {
			t.Fatalf("%s: code = %d, want %d (%s)", c.name, w.Code, c.code, w.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if _, ok := body[c.key]; !ok {
			t.Fatalf("%s: body %v has no %q", c.name, body, c.key)
		}
	}
	w := httptest.NewRecorder()
	writeErr(w, &store.LockedError{Msg: "đã khoá"})
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["locked"] != true || body["error"] != "đã khoá" {
		t.Fatalf("locked body = %v", body)
	}
}
