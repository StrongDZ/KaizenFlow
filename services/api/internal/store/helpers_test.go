package store_test

import (
	"testing"
	"time"

	"github.com/kaizenflow/api/internal/simfake"
	"github.com/kaizenflow/api/internal/store"
)

// doneRun tạo một run đã xong với kết quả mẫu của simfake (2 band, RED_RISK + RECOMMENDATION, 1 event).
func doneRun(t *testing.T, st *store.Store, scenarioID int64) int64 {
	t.Helper()
	rid, err := st.InsertRun(ctx, scenarioID, time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC), "FORECAST")
	if err != nil {
		t.Fatal(err)
	}
	res := simfake.Result(rid)
	if err := st.SaveResult(ctx, rid, &res); err != nil {
		t.Fatal(err)
	}
	return rid
}
