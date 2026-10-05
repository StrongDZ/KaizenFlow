package httpserver

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthAndMetrics(t *testing.T) {
	var unhealthy error
	server := httptest.NewServer(Handler(NewRegistry(), func() error { return unhealthy }))
	defer server.Close()

	get := func(path string) (int, string) {
		resp, err := http.Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		buf := make([]byte, 1<<16)
		n, _ := resp.Body.Read(buf)
		return resp.StatusCode, string(buf[:n])
	}

	if code, body := get("/healthz"); code != 200 || strings.TrimSpace(body) != "ok" {
		t.Errorf("healthy: %d %q", code, body)
	}
	unhealthy = errors.New("mqtt disconnected")
	if code, body := get("/healthz"); code != 503 || !strings.Contains(body, "mqtt disconnected") {
		t.Errorf("unhealthy: %d %q", code, body)
	}
	if code, body := get("/metrics"); code != 200 || !strings.Contains(body, "go_goroutines") {
		t.Errorf("metrics: %d", code)
	}
}
