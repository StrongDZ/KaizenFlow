package store

import (
	"context"
	"regexp"
	"strconv"

	"github.com/jackc/pgx/v5"
)

// Asset là một thiết bị thật của nhà máy: định danh duy nhất toàn app, không thuộc mô hình nào.
// NodeType là loại (lớp trừu tượng) của nó; Params là tham số thật của chính thiết bị này.
// Node trong một version mô hình chỉ tham chiếu Key và có thể override thêm.
type Asset struct {
	Key      string         `json:"key"`
	Plant    string         `json:"plant"`
	Line     string         `json:"line"`
	NodeType string         `json:"node_type"`
	Name     string         `json:"name"`
	Params   map[string]any `json:"params"`
	Note     string         `json:"note"`
	Retired  bool           `json:"retired"`
	// Models là các mô hình đang dùng thiết bị này (chỉ đọc, để biết sửa sẽ ảnh hưởng tới đâu).
	Models []string `json:"models"`
}

// assetKeyRe: mã thiết bị cũng là machine_id của gauge-twin, nên giữ đúng tập ký tự mà bên đó nhận.
var assetKeyRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)

const assetCols = `a.key, a.plant, a.line, t.code, a.name, a.params, a.note, a.retired`

func scanAsset(r pgx.Row) (Asset, error) {
	var a Asset
	var models []string
	err := r.Scan(&a.Key, &a.Plant, &a.Line, &a.NodeType, &a.Name, &a.Params, &a.Note, &a.Retired, &models)
	if models == nil {
		models = []string{}
	}
	a.Models = models
	if a.Params == nil {
		a.Params = map[string]any{}
	}
	return a, err
}

// assetModels: mô hình nào đang chứa thiết bị nào (theo node.key, mọi version).
const assetModels = `(SELECT coalesce(array_agg(DISTINCT v.model_key ORDER BY v.model_key), '{}')
	FROM node n JOIN model_version v ON v.id = n.model_version_id WHERE n.key = a.key)`

func (s *Store) ListAssets(ctx context.Context) ([]Asset, error) {
	rows, err := s.Pool.Query(ctx, `SELECT `+assetCols+`, `+assetModels+`
		FROM asset a JOIN node_type t ON t.id = a.node_type_id ORDER BY a.plant, a.line, a.key`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Asset, error) { return scanAsset(r) })
}

func (s *Store) GetAsset(ctx context.Context, key string) (*Asset, error) {
	row := s.Pool.QueryRow(ctx, `SELECT `+assetCols+`, `+assetModels+`
		FROM asset a JOIN node_type t ON t.id = a.node_type_id WHERE a.key = $1`, key)
	a, err := scanAsset(row)
	if err != nil {
		return nil, notFound(err)
	}
	return &a, nil
}

// SignalHints là những gì cần biết thêm về một thiết bị để liệt kê đúng danh mục tín hiệu của nó,
// nhưng lại không nằm ở thiết bị: vật tư của kho (`stock`) và loại xe của đội xe (`kind`) được khai
// trong tham số NODE của từng mô hình (bản đã Publish đông cứng ở đó).
type SignalHints struct {
	// Materials là vật tư kho đang khai, gom từ mọi mô hình dùng thiết bị này (`level:<vật tư>`).
	Materials []string
	// Kind là loại xe của đội xe; lấy giá trị gặp đầu tiên (một đội xe chỉ là một loại).
	Kind string
}

// AssetSignalHints gom các gợi ý đó theo mã thiết bị. Không gom thì trang Tín hiệu thiết bị sẽ
// không có dòng nào cho kho, và `fleet` của đội xe bị coi là tín hiệu không hợp lệ.
func (s *Store) AssetSignalHints(ctx context.Context) (map[string]SignalHints, error) {
	out := map[string]SignalHints{}
	rows, err := s.Pool.Query(ctx, `SELECT DISTINCT n.key, item ->> 'material' AS material
		FROM node n, jsonb_array_elements(n.params -> 'stock') AS item
		WHERE jsonb_typeof(n.params -> 'stock') = 'array' AND item ->> 'material' IS NOT NULL
		ORDER BY n.key, material`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var key, material string
		if err := rows.Scan(&key, &material); err != nil {
			rows.Close()
			return nil, err
		}
		h := out[key]
		h.Materials = append(h.Materials, material)
		out[key] = h
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows, err = s.Pool.Query(ctx, `SELECT DISTINCT ON (n.key) n.key, n.params ->> 'kind'
		FROM node n WHERE n.params ->> 'kind' IS NOT NULL ORDER BY n.key, n.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var key, kind string
		if err := rows.Scan(&key, &kind); err != nil {
			return nil, err
		}
		h := out[key]
		h.Kind = kind
		out[key] = h
	}
	return out, rows.Err()
}

// PutAsset thêm hoặc sửa một thiết bị. Đổi loại node khi thiết bị đã nằm trong mô hình thì bị chặn:
// loại quyết định tham số và vai trò, đổi ngầm sẽ làm sơ đồ đang dùng nó sai mà không ai biết.
func (s *Store) PutAsset(ctx context.Context, a Asset) (*Asset, error) {
	if !assetKeyRe.MatchString(a.Key) {
		return nil, &RefError{a.Key, "Mã thiết bị chỉ gồm chữ, số, '_', '.', '-' và dài 1–64 ký tự."}
	}
	if a.Params == nil {
		a.Params = map[string]any{}
	}
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var typeID int64
		if err := tx.QueryRow(ctx, `SELECT id FROM node_type WHERE code = $1`, a.NodeType).Scan(&typeID); err != nil {
			if err == pgx.ErrNoRows {
				return &RefError{a.Key, "Loại node '" + a.NodeType + "' không có trong Thư viện."}
			}
			return err
		}
		var oldType string
		switch err := tx.QueryRow(ctx, `SELECT t.code FROM asset a JOIN node_type t ON t.id = a.node_type_id
			WHERE a.key = $1 FOR UPDATE OF a`, a.Key).Scan(&oldType); {
		case err == pgx.ErrNoRows: // thiết bị mới
		case err != nil:
			return err
		case oldType != a.NodeType:
			var used int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM node WHERE key = $1`, a.Key).Scan(&used); err != nil {
				return err
			}
			if used > 0 {
				return &LockedError{Msg: "Thiết bị " + a.Key + " đang nằm trong " + strconv.Itoa(used) +
					" sơ đồ nên không đổi được loại node. Gỡ nó khỏi các sơ đồ đó trước, hoặc tạo thiết bị mới."}
			}
		}
		_, err := tx.Exec(ctx, `INSERT INTO asset (key, plant, line, node_type_id, name, params, note, retired)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (key) DO UPDATE SET plant = EXCLUDED.plant, line = EXCLUDED.line,
			  node_type_id = EXCLUDED.node_type_id, name = EXCLUDED.name, params = EXCLUDED.params,
			  note = EXCLUDED.note, retired = EXCLUDED.retired, updated_at = now()`,
			a.Key, a.Plant, a.Line, typeID, a.Name, a.Params, a.Note, a.Retired)
		return err
	})
	if err != nil {
		return nil, err
	}
	return s.GetAsset(ctx, a.Key)
}

// DeleteAsset xoá một thiết bị khỏi danh mục. Còn sơ đồ nào dùng thì không xoá (dùng Retired để
// ngừng dùng mà vẫn giữ lịch sử số liệu và các version đã Publish).
func (s *Store) DeleteAsset(ctx context.Context, key string) error {
	var used []string
	rows, err := s.Pool.Query(ctx, `SELECT DISTINCT v.model_key FROM node n
		JOIN model_version v ON v.id = n.model_version_id WHERE n.key = $1 ORDER BY v.model_key`, key)
	if err != nil {
		return err
	}
	used, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (string, error) {
		var m string
		err := r.Scan(&m)
		return m, err
	})
	if err != nil {
		return err
	}
	if len(used) > 0 {
		return &LockedError{Msg: "Thiết bị " + key + " đang nằm trong sơ đồ của " + strconv.Itoa(len(used)) +
			" mô hình. Gỡ khỏi các sơ đồ đó trước, hoặc đánh dấu Ngừng dùng.", Usage: used}
	}
	tag, err := s.Pool.Exec(ctx, `DELETE FROM asset WHERE key = $1`, key)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	// Ghép nối tín hiệu toàn cục của thiết bị đã xoá thì không còn đối tượng nào, bỏ luôn.
	_, err = s.Pool.Exec(ctx, `DELETE FROM data_binding WHERE model_key = '' AND subject = $1`, key)
	return err
}
