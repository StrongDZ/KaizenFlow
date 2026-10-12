package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/kaizenflow/api/internal/live"
	"github.com/kaizenflow/api/internal/resolve"
	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/validate"
)

// Danh mục Thiết bị: thiết bị thật của nhà máy, định danh duy nhất toàn app. Sơ đồ của một mô hình
// chỉ ĐẶT thiết bị đã có ở đây; tín hiệu ghép cho thiết bị dùng chung cho mọi mô hình chứa nó.

// assetView là thiết bị kèm những gì suy ra từ loại node: vai trò và danh mục tín hiệu ghép được.
type assetView struct {
	store.Asset
	Archetype string           `json:"archetype"`
	Signals   []live.SignalDef `json:"signals"`
	// effective là tham số hiệu lực dùng để tính danh mục tín hiệu (đã gồm gợi ý lấy từ node).
	// Không gửi ra API; chỉ để kiểm tra tín hiệu hợp lệ khi lưu ghép nối.
	effective map[string]any
}

// assetViews gắn vai trò và tín hiệu cho từng thiết bị. Tín hiệu tính trên tham số hiệu lực:
// default của loại ⊕ params thiết bị ⊕ gợi ý lấy từ tham số node (vật tư của kho, loại xe của đội
// xe) — hai thứ sau được khai trong mô hình chứ không ở thiết bị, nên phải gom vào đây.
func (h *handlers) assetViews(ctx context.Context, list []store.Asset) ([]assetView, error) {
	types, err := h.Store.ListNodeTypes(ctx)
	if err != nil {
		return nil, err
	}
	byCode := map[string]store.NodeType{}
	for _, t := range types {
		byCode[t.Code] = t
	}
	hints, err := h.Store.AssetSignalHints(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]assetView, 0, len(list))
	for _, a := range list {
		v := assetView{Asset: a, Signals: []live.SignalDef{}}
		t, ok := byCode[a.NodeType]
		if !ok {
			out = append(out, v)
			continue
		}
		v.Archetype = t.Archetype
		params, err := resolve.MergeNodeParams(t, store.GraphNode{Key: a.Key, AssetParams: a.Params})
		if err != nil {
			return nil, err
		}
		hint := hints[a.Key]
		if len(hint.Materials) > 0 {
			declared := map[string]bool{}
			merged, _ := params["stock"].([]any)
			for _, raw := range merged {
				if m, ok := raw.(map[string]any); ok {
					if code, ok := m["material"].(string); ok {
						declared[code] = true
					}
				}
			}
			for _, code := range hint.Materials {
				if !declared[code] {
					merged = append(merged, map[string]any{"material": code})
				}
			}
			params["stock"] = merged
		}
		if _, ok := params["kind"].(string); !ok && hint.Kind != "" {
			params["kind"] = hint.Kind
		}
		v.effective = params
		if sigs := live.SignalsFor(t.Archetype, params); sigs != nil {
			v.Signals = sigs
		}
		out = append(out, v)
	}
	return out, nil
}

func (h *handlers) listAssets(w http.ResponseWriter, r *http.Request) {
	list, err := h.Store.ListAssets(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	views, err := h.assetViews(r.Context(), list)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, views)
}

func (h *handlers) getAsset(w http.ResponseWriter, r *http.Request) {
	a, err := h.Store.GetAsset(r.Context(), chi.URLParam(r, "key"))
	if err != nil {
		writeErr(w, err)
		return
	}
	views, err := h.assetViews(r.Context(), []store.Asset{*a})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, views[0])
}

func (h *handlers) putAsset(w http.ResponseWriter, r *http.Request) {
	var a store.Asset
	if !decode(w, r, &a) {
		return
	}
	if key := chi.URLParam(r, "key"); key != "" {
		a.Key = key
	}
	a.Key = strings.TrimSpace(a.Key)
	a.NodeType = strings.TrimSpace(a.NodeType)
	switch {
	case a.Key == "":
		writeJSON(w, 422, issues(validate.Issue{Key: "key", Message: "Thiếu mã thiết bị."}))
		return
	case a.NodeType == "":
		writeJSON(w, 422, issues(validate.Issue{Key: a.Key, Message: "Thiếu loại node của thiết bị."}))
		return
	}
	saved, err := h.Store.PutAsset(r.Context(), a)
	if err != nil {
		writeErr(w, err)
		return
	}
	views, err := h.assetViews(r.Context(), []store.Asset{*saved})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, views[0])
}

func (h *handlers) deleteAsset(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.DeleteAsset(r.Context(), chi.URLParam(r, "key")); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(204)
}

// listAssetBindings trả ghép nối tín hiệu của thiết bị (không thuộc mô hình nào).
func (h *handlers) listAssetBindings(w http.ResponseWriter, r *http.Request) {
	list, err := h.Store.ListAssetBindings(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	if list == nil {
		list = []live.Binding{}
	}
	writeJSON(w, 200, map[string]any{"bindings": list})
}

// putAssetBindings ghi ghép nối tín hiệu thiết bị; mọi mô hình có thiết bị đó dùng được ngay.
// Chỉ nhận chế độ "từ nguồn": công thức tự tính cần các đối tượng quanh nó trong một sơ đồ cụ thể,
// nên vẫn làm ở trang Kết nối dữ liệu của mô hình.
func (h *handlers) putAssetBindings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var body struct {
		Bindings []struct {
			Subject   string         `json:"subject"`
			Signal    string         `json:"signal"`
			Source    string         `json:"source"`
			JSONPath  string         `json:"json_path"`
			Transform live.Transform `json:"transform"`
			Enabled   *bool          `json:"enabled"`
		} `json:"bindings"`
	}
	if !decode(w, r, &body) {
		return
	}
	all, err := h.Store.ListAssets(ctx)
	if err != nil {
		writeErr(w, err)
		return
	}
	views, err := h.assetViews(ctx, all)
	if err != nil {
		writeErr(w, err)
		return
	}
	byKey := map[string]assetView{}
	for _, v := range views {
		byKey[v.Key] = v
	}
	var list []validate.Issue
	bs := make([]live.Binding, 0, len(body.Bindings))
	for _, in := range body.Bindings {
		v, ok := byKey[in.Subject]
		if !ok {
			list = append(list, validate.Issue{Key: in.Subject,
				Message: "'" + in.Subject + "' không có trong danh mục Thiết bị. Tín hiệu của đường nối ghép ở trang Kết nối dữ liệu của mô hình."})
			continue
		}
		if !live.ValidSignal(v.Archetype, v.effective, in.Signal) {
			list = append(list, validate.Issue{Key: in.Subject, Message: "tín hiệu '" + in.Signal + "' không hợp lệ cho thiết bị này"})
			continue
		}
		if strings.TrimSpace(in.Source) == "" {
			list = append(list, validate.Issue{Key: in.Subject, Message: "Thiếu nguồn dữ liệu."})
			continue
		}
		bs = append(bs, live.Binding{Subject: in.Subject, Signal: in.Signal, Source: in.Source, JSONPath: in.JSONPath,
			Transform: in.Transform, Enabled: in.Enabled == nil || *in.Enabled, Mode: live.ModeSource})
	}
	if len(list) > 0 {
		writeJSON(w, 422, issues(list...))
		return
	}
	if r.URL.Query().Get("check") == "1" {
		writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}
	if err := h.Store.SaveBindings(ctx, "", bs); err != nil {
		writeErr(w, err)
		return
	}
	if h.Live != nil {
		if err := h.Live.ReloadBindings(ctx); err != nil {
			writeErr(w, err)
			return
		}
	}
	h.listAssetBindings(w, r)
}

func (h *handlers) deleteAssetBinding(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := h.Store.DeleteBinding(r.Context(), "", id); err != nil {
		writeErr(w, err)
		return
	}
	if h.Live != nil {
		if err := h.Live.ReloadBindings(r.Context()); err != nil {
			writeErr(w, err)
			return
		}
	}
	w.WriteHeader(204)
}
