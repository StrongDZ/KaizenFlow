package db_test

import (
	"context"
	"testing"

	"github.com/kaizenflow/api/internal/db"
	"github.com/kaizenflow/api/internal/testdb"
)

// Hai migration của tách thiết bị / chỗ đặt có khối Down không tầm thường (trả ghép nối toàn cục và
// số đọc live về từng mô hình, dựng lại các cột của node). Khối Down hỏng chỉ lộ ra đúng lúc cần
// lùi, nên test này lùi rồi tiến lại và kiểm cả hai chiều dựng đúng schema.
func TestAssetMigrationsRollBackAndForward(t *testing.T) {
	pool := testdb.New(t, "db_down")
	ctx := context.Background()
	has := func(column string) bool {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = 'node' AND column_name = $1`, column).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n == 1
	}
	hasTable := func(name string) bool {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = $1`, name).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n == 1
	}
	if !hasTable("asset") || has("node_type_id") {
		t.Fatalf("sau khi migrate: asset=%v, node.node_type_id=%v", hasTable("asset"), has("node_type_id"))
	}
	// Dựng dữ liệu để khối Down phải thật sự di chuyển: một thiết bị nằm trong hai mô hình, một ghép
	// nối toàn cục và một số đọc live toàn cục của thiết bị đó.
	for _, q := range []string{
		`INSERT INTO node_type (code, name, archetype, param_schema) VALUES ('T', 'T', 'PROCESS', '{}')`,
		`INSERT INTO asset (key, node_type_id, name, params) SELECT 'M1', id, 'Máy 1', '{"a":1}' FROM node_type WHERE code='T'`,
		`INSERT INTO model_version (model_key, version, status) VALUES ('mo-a', 1, 'PUBLISHED'), ('mo-b', 1, 'PUBLISHED')`,
		`INSERT INTO node (model_version_id, key, params) SELECT id, 'M1', '{}' FROM model_version`,
		`INSERT INTO data_binding (model_key, subject, signal, source, json_path) VALUES ('', 'M1', 'state', 'plc/m1', 'st')`,
		`INSERT INTO signal (time, model_key, subject, name, value) VALUES (now(), '', 'M1', 'count_ok', 5)`,
		`INSERT INTO event_log (time, model_key, subject, type) VALUES (now(), '', 'M1', 'DOWN')`,
	} {
		if _, err := pool.Exec(ctx, q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	// Lùi dần tới khi node lấy lại loại/vai trò/tên (đếm theo điều kiện, không theo số migration,
	// để thêm migration mới sau này không làm test này sai).
	down := func(label string, until func() bool) {
		t.Helper()
		for i := 0; i < 10; i++ {
			if until() {
				return
			}
			if err := db.MigrateDown(pool, 1); err != nil {
				t.Fatalf("lùi (%s): %v", label, err)
			}
		}
		t.Fatalf("lùi 10 bước vẫn chưa đạt: %s", label)
	}
	down("node lấy lại cột loại/vai trò/tên", func() bool { return has("node_type_id") && has("archetype") && has("name") })
	count := func(q string) int {
		var n int
		if err := pool.QueryRow(ctx, q).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := count(`SELECT count(*) FROM signal WHERE run_id IS NULL AND subject='M1' AND model_key <> ''`); n != 2 {
		t.Fatalf("lùi 00009: số đọc live phải trải về 2 mô hình, có %d", n)
	}
	if n := count(`SELECT count(*) FROM signal WHERE run_id IS NULL AND model_key = ''`); n != 0 {
		t.Fatalf("lùi 00009: còn sót hàng toàn cục: %d", n)
	}
	if n := count(`SELECT count(*) FROM event_log WHERE run_id IS NULL AND subject='M1' AND model_key <> ''`); n != 2 {
		t.Fatalf("lùi 00009: sự kiện live phải trải về 2 mô hình, có %d", n)
	}
	if n := count(`SELECT count(*) FROM node WHERE key='M1' AND node_type_id IS NOT NULL AND name = 'Máy 1'`); n != 2 {
		t.Fatalf("lùi 00009: node chưa lấy lại loại và tên, có %d", n)
	}
	// Lùi tiếp tới khi hết danh mục thiết bị.
	down("xoá bảng asset", func() bool { return !hasTable("asset") })
	if n := count(`SELECT count(*) FROM data_binding WHERE subject='M1' AND model_key IN ('mo-a','mo-b')`); n != 2 {
		t.Fatalf("lùi 00008: ghép nối toàn cục phải trải về 2 mô hình, có %d", n)
	}
	if n := count(`SELECT count(*) FROM data_binding WHERE model_key = ''`); n != 0 {
		t.Fatalf("lùi 00008: còn sót ghép nối toàn cục: %d", n)
	}
	// Tiến lại: về đúng trạng thái hiện tại.
	if err := db.Migrate(pool); err != nil {
		t.Fatalf("tiến lại: %v", err)
	}
	if !hasTable("asset") || has("node_type_id") {
		t.Fatalf("tiến lại: asset=%v, node.node_type_id=%v", hasTable("asset"), has("node_type_id"))
	}
}
