package ws_test

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/kaizenflow/api/internal/ws"
)

func TestBroadcastReachesSubscriberAndWebSocket(t *testing.T) {
	h := ws.NewHub()
	ch, unsub := h.Subscribe()
	h.Broadcast(map[string]any{"type": "run_status", "run_id": 1})
	if msg := <-ch; !strings.Contains(string(msg), `"run_id":1`) {
		t.Fatalf("msg = %s", msg)
	}
	unsub()
	h.Broadcast(map[string]any{"x": 1}) // không panic sau khi huỷ

	srv := httptest.NewServer(h)
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	time.Sleep(50 * time.Millisecond) // chờ server đăng ký subscriber
	h.Broadcast(map[string]any{"run_id": 2})
	_, msg, err := c.Read(ctx)
	if err != nil || !strings.Contains(string(msg), `"run_id":2`) {
		t.Fatalf("ws msg = %s %v", msg, err)
	}
}
