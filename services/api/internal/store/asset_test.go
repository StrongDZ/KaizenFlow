package store_test

import (
	"errors"
	"testing"
	"time"

	"github.com/kaizenflow/api/internal/live"
	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/testfix"
)

// Sơ đồ chỉ ĐẶT thiết bị đã khai: node lạ bị chặn ngay lúc lưu, kèm thông điệp chỉ việc cần làm.
func TestReplaceGraphRequiresAnAsset(t *testing.T) {
	st := testfix.Seeded(t, "store_asset_required")
	vid := newModel(t, st, "need-asset")
	nodes := append(testfix.MiniNodes(), store.GraphNode{Key: "LA", NodeType: "STAMP_PRESS", Params: map[string]any{}})
	var re *store.RefError
	if err := st.ReplaceGraph(ctx, vid, nodes, nil, nil); !errors.As(err, &re) || re.Key != "LA" {
		t.Fatalf("node chưa có thiết bị phải bị chặn, got %v", err)
	}
	testfix.RegisterAssets(t, st, nodes[len(nodes)-1:])
	if err := st.ReplaceGraph(ctx, vid, nodes, nil, nil); err != nil {
		t.Fatalf("khai thiết bị rồi phải lưu được: %v", err)
	}
}

// Loại node do danh mục Thiết bị quyết định: sơ đồ gửi loại khác là dữ liệu lệch, không im lặng nhận.
func TestReplaceGraphRejectsATypeThatDisagreesWithTheAsset(t *testing.T) {
	st := testfix.Seeded(t, "store_asset_type")
	vid := newModel(t, st, "type-clash")
	nodes := testfix.MiniNodes()
	nodes[1].NodeType = "STAMP_PRESS" // thật ra S là RACK_WAREHOUSE
	var re *store.RefError
	if err := st.ReplaceGraph(ctx, vid, nodes, nil, nil); !errors.As(err, &re) || re.Key != "S" {
		t.Fatalf("loại lệch với thiết bị phải bị chặn, got %v", err)
	}
}

// Một thiết bị dùng ở nhiều mô hình: tham số khai một lần ở danh mục, mô hình nào cũng thấy.
func TestAssetParamsReachEveryModelUsingIt(t *testing.T) {
	st := testfix.Seeded(t, "store_asset_params")
	if _, err := st.PutAsset(ctx, store.Asset{Key: "S", NodeType: "RACK_WAREHOUSE",
		Params: map[string]any{"capacity": 777.0}}); err != nil {
		t.Fatal(err)
	}
	for _, m := range []string{"m-one", "m-two"} {
		vid := newModel(t, st, m)
		if err := st.ReplaceGraph(ctx, vid, testfix.MiniNodes(), testfix.MiniEdges(), nil); err != nil {
			t.Fatal(err)
		}
		g, err := st.GetGraph(ctx, vid)
		if err != nil {
			t.Fatal(err)
		}
		var found bool
		for _, n := range g.Nodes {
			if n.Key == "S" {
				found = true
				if n.AssetParams["capacity"] != 777.0 {
					t.Fatalf("%s: asset_params = %v", m, n.AssetParams)
				}
			}
		}
		if !found {
			t.Fatalf("%s: không thấy node S", m)
		}
	}
	// Đổi loại thiết bị khi nó đã nằm trong sơ đồ thì bị chặn (loại quyết định tham số và vai trò).
	var lk *store.LockedError
	if _, err := st.PutAsset(ctx, store.Asset{Key: "S", NodeType: "STAMP_PRESS"}); !errors.As(err, &lk) {
		t.Fatalf("đổi loại khi đang dùng phải bị chặn, got %v", err)
	}
	// Và xoá thiết bị đang dùng cũng bị chặn, kèm danh sách mô hình.
	if err := st.DeleteAsset(ctx, "S"); !errors.As(err, &lk) {
		t.Fatalf("xoá thiết bị đang dùng phải bị chặn, got %v", err)
	}
}

// Tín hiệu live của một thiết bị lưu MỘT bản dù nhiều mô hình dùng chung, và mô hình nào có thiết
// bị đó thì đọc được; mô hình không có thì không thấy. Tín hiệu đường nối vẫn riêng từng mô hình.
func TestLiveSignalsOfADeviceAreStoredOnceAndSharedByModels(t *testing.T) {
	st := testfix.Seeded(t, "store_live_shared")
	for _, m := range []string{"l-one", "l-two"} {
		vid := newModel(t, st, m)
		if err := st.ReplaceGraph(ctx, vid, testfix.MiniNodes(), testfix.MiniEdges(), nil); err != nil {
			t.Fatal(err)
		}
	}
	vid := newModel(t, st, "l-khac")
	if err := st.ReplaceGraph(ctx, vid, testfix.MiniNodes()[:1], nil, nil); err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)
	// livesvc sinh cùng một số đọc cho mỗi mô hình dùng thiết bị: chỉ được lưu một bản.
	if err := st.InsertLive(ctx, []store.LiveSignal{
		{Time: at, Model: "l-one", Subject: "S", Name: "level:RAW-01", Value: 42},
		{Time: at, Model: "l-two", Subject: "S", Name: "level:RAW-01", Value: 42},
		{Time: at, Model: "l-one", Subject: "S>OUT", Name: "moved", Value: 7},
	}, nil); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := st.Pool.QueryRow(ctx, `SELECT count(*) FROM signal WHERE run_id IS NULL AND subject = 'S'`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("tín hiệu thiết bị phải lưu một bản, có %d", rows)
	}
	for _, m := range []string{"l-one", "l-two"} {
		got, err := st.LiveSignals(ctx, m, "S", "level:RAW-01", nil, nil, 10)
		if err != nil || len(got) != 1 || got[0].Value != 42 {
			t.Fatalf("%s: đọc tín hiệu thiết bị = %+v, %v", m, got, err)
		}
	}
	// Mô hình chỉ có SRC thì không thấy tín hiệu của S.
	if got, err := st.LiveSignals(ctx, "l-khac", "S", "level:RAW-01", nil, nil, 10); err != nil || len(got) != 0 {
		t.Fatalf("mô hình không chứa thiết bị không được thấy tín hiệu của nó: %+v, %v", got, err)
	}
	// Tín hiệu đường nối chỉ thuộc mô hình đã ghi.
	if got, _ := st.LiveSignals(ctx, "l-one", "S>OUT", "moved", nil, nil, 10); len(got) != 1 {
		t.Fatalf("l-one phải thấy tín hiệu đường nối, có %d", len(got))
	}
	if got, _ := st.LiveSignals(ctx, "l-two", "S>OUT", "moved", nil, nil, 10); len(got) != 0 {
		t.Fatalf("l-two không được thấy tín hiệu đường nối của l-one, có %d", len(got))
	}
	// Xoá live của l-one không được làm mất số đọc thiết bị mà l-two vẫn dùng.
	if err := st.ClearLive(ctx, "l-one"); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.LiveSignals(ctx, "l-two", "S", "level:RAW-01", nil, nil, 10); len(got) != 1 {
		t.Fatalf("xoá live của mô hình khác đã làm mất số đọc thiết bị dùng chung")
	}
}

// Ghép nối tín hiệu của thiết bị lưu một lần và áp cho mọi mô hình có thiết bị đó.
func TestAssetBindingIsSharedByEveryModel(t *testing.T) {
	st := testfix.Seeded(t, "store_asset_binding")
	for _, m := range []string{"b-one", "b-two"} {
		vid := newModel(t, st, m)
		if err := st.ReplaceGraph(ctx, vid, testfix.MiniNodes(), testfix.MiniEdges(), nil); err != nil {
			t.Fatal(err)
		}
	}
	// Lưu từ trong một mô hình, nhưng vì S là thiết bị nên ghép nối thành dùng chung.
	if err := st.SaveBindings(ctx, "b-one", []live.Binding{
		{Subject: "S", Signal: "level:RAW-01", Source: "plc/s/level", Enabled: true, Mode: live.ModeSource},
		{Subject: "S>OUT", Signal: "moved", Source: "plc/s/moved", Enabled: true, Mode: live.ModeSource},
	}); err != nil {
		t.Fatal(err)
	}
	global, err := st.ListAssetBindings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(global) != 1 || global[0].Subject != "S" {
		t.Fatalf("chỉ tín hiệu thiết bị là dùng chung, got %+v", global)
	}
	// Mô hình thứ hai chưa ghép gì mà vẫn thấy tín hiệu của thiết bị; đường nối thì không.
	two, err := st.ListBindings(ctx, "b-two")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, b := range two {
		got[b.Subject] = b.ModelKey
	}
	if got["S"] != "b-two" {
		t.Fatalf("mô hình khác phải thấy ghép nối thiết bị, got %+v", two)
	}
	if _, ok := got["S>OUT"]; ok {
		t.Fatalf("ghép nối đường nối không được lọt sang mô hình khác, got %+v", two)
	}
	// Đường ingest cũng phải thấy ghép nối thiết bị dưới cả hai mô hình.
	all, err := st.AllBindings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	models := map[string]bool{}
	for _, b := range all {
		if b.Subject == "S" {
			models[b.ModelKey] = true
		}
	}
	if !models["b-one"] || !models["b-two"] {
		t.Fatalf("AllBindings phải trải ghép nối thiết bị ra mọi mô hình, got %v", models)
	}
}
