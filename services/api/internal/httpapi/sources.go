package httpapi

import (
	"encoding/json"
	"maps"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/kaizenflow/api/internal/live"
	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/validate"
)

// liveSilentAfter: nguồn không có bản tin quá khoảng này (giờ thật) thì coi là mất tín hiệu, cùng ngưỡng với trạng thái node.
const liveSilentAfter = 15 * time.Second

// bindingRef: một ghép nối đang lấy dữ liệu từ nguồn. Model rỗng là ghép nối của thiết bị, dùng chung
// cho mọi mô hình có thiết bị đó (chỉ danh mục toàn cục điền Model).
type bindingRef struct {
	Model   string `json:"model,omitempty"`
	Subject string `json:"subject"`
	Signal  string `json:"signal"`
}

type sourceView struct {
	Source    string          `json:"source"`
	Desc      string          `json:"desc"`
	Origin    string          `json:"origin"`
	FirstSeen time.Time       `json:"first_seen"`
	LastSeen  time.Time       `json:"last_seen"`
	Count     int64           `json:"count"`
	Sample    json.RawMessage `json:"sample"`
	Live      bool            `json:"live"`
	AgeMS     int64           `json:"age_ms"`
	PerMin    float64         `json:"per_min"`
	Bindings  []bindingRef    `json:"bindings"`
}

// modelExists: 404 nếu mô hình chưa có phiên bản nào (tức chưa có mô hình).
func (h *handlers) modelExists(w http.ResponseWriter, r *http.Request, model string) bool {
	vs, err := h.Store.ListVersions(r.Context(), model)
	if err != nil {
		writeErr(w, err)
		return false
	}
	if len(vs) == 0 {
		writeErr(w, store.ErrNotFound)
		return false
	}
	return true
}

func boundTo(bs []live.Binding, source string) []bindingRef {
	out := []bindingRef{}
	for _, b := range bs {
		if live.MatchSource(b.Source, source) {
			out = append(out, bindingRef{Subject: b.Subject, Signal: b.Signal})
		}
	}
	return out
}

// listSources: GET /api/models/{key}/sources. Danh sách lấy từ DB (sống sót qua khởi động lại), trạng thái sống lấy từ bộ nhớ.
func (h *handlers) listSources(w http.ResponseWriter, r *http.Request) {
	model := chi.URLParam(r, "key")
	if !h.modelExists(w, r, model) {
		return
	}
	rows, err := h.Store.ListSources(r.Context(), model)
	if err != nil {
		writeErr(w, err)
		return
	}
	bs, err := h.Store.ListBindings(r.Context(), model)
	if err != nil {
		writeErr(w, err)
		return
	}
	ram := map[string]live.SourceSnap{}
	for _, s := range h.Live.Snapshot(model).Sources {
		ram[s.Source] = s
	}
	now := time.Now()
	out := make([]sourceView, 0, len(rows))
	for _, d := range rows {
		v := sourceView{Source: d.Source, Desc: d.Desc, Origin: d.Origin, FirstSeen: d.FirstSeen, LastSeen: d.LastSeen, Count: d.Count,
			Sample: d.Sample, AgeMS: now.Sub(d.LastSeen).Milliseconds(), Bindings: boundTo(bs, d.Source)}
		if s, ok := ram[d.Source]; ok {
			v.AgeMS, v.PerMin = s.AgeMS, s.PerMin
			v.Count = max(v.Count, s.Count)
			if b, err := json.Marshal(s.Last); err == nil && s.Last != nil {
				v.Sample = b
			}
			if v.Desc == "" {
				v.Desc = s.Desc
			}
			v.Live = s.AgeMS < liveSilentAfter.Milliseconds()
		}
		out = append(out, v)
	}
	writeJSON(w, 200, map[string]any{"sources": out})
}

// globalSourceView: một nguồn trong danh mục toàn cục, kèm các mô hình đang có ghép nối dùng nó.
type globalSourceView struct {
	sourceView
	Models []string `json:"models"`
}

// listAllSources: GET /api/sources. Toàn bộ danh mục nguồn (thiết bị/topic ngoài đời, không thuộc mô hình nào):
// danh sách lấy từ DB, trạng thái sống gộp từ bộ nhớ của mọi mô hình, "đang dùng cho" gồm cả ghép nối
// của thiết bị (dùng chung) lẫn ghép nối đường nối của từng mô hình. "Dùng ở" suy từ chính các ghép nối
// đó (kể cả ghép nối dùng ký tự thay thế, thứ SQL không khớp được): ghép nối thiết bị tính cho mọi mô
// hình đang chứa thiết bị.
func (h *handlers) listAllSources(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := h.Store.ListAllSources(ctx)
	if err != nil {
		writeErr(w, err)
		return
	}
	bs, err := h.Store.ListStoredBindings(ctx)
	if err != nil {
		writeErr(w, err)
		return
	}
	assets, err := h.Store.ListAssets(ctx)
	if err != nil {
		writeErr(w, err)
		return
	}
	modelsOf := map[string][]string{}
	for _, a := range assets {
		modelsOf[a.Key] = a.Models
	}
	ram := map[string]live.SourceSnap{}
	for _, s := range h.Live.Sources() {
		ram[s.Source] = s
	}
	now := time.Now()
	out := make([]globalSourceView, 0, len(rows))
	for _, d := range rows {
		v := sourceView{Source: d.Source, Desc: d.Desc, Origin: d.Origin, FirstSeen: d.FirstSeen, LastSeen: d.LastSeen, Count: d.Count,
			Sample: d.Sample, AgeMS: now.Sub(d.LastSeen).Milliseconds(), Bindings: []bindingRef{}}
		used := map[string]bool{}
		for _, b := range bs {
			if live.MatchSource(b.Source, d.Source) {
				v.Bindings = append(v.Bindings, bindingRef{Model: b.ModelKey, Subject: b.Subject, Signal: b.Signal})
				if b.ModelKey != "" {
					used[b.ModelKey] = true
				} else {
					for _, m := range modelsOf[b.Subject] {
						used[m] = true
					}
				}
			}
		}
		if s, ok := ram[d.Source]; ok {
			v.AgeMS, v.PerMin = s.AgeMS, s.PerMin
			v.Count = max(v.Count, s.Count)
			if b, err := json.Marshal(s.Last); err == nil && s.Last != nil {
				v.Sample = b
			}
			if v.Desc == "" {
				v.Desc = s.Desc
			}
			v.Live = s.AgeMS < liveSilentAfter.Milliseconds()
		}
		models := slices.Sorted(maps.Keys(used))
		if models == nil {
			models = []string{}
		}
		out = append(out, globalSourceView{sourceView: v, Models: models})
	}
	writeJSON(w, 200, out)
}

// addSource: POST /api/sources. Người dùng khai báo một nguồn bằng cách dán bản tin mẫu; nguồn dùng được ở mọi mô hình.
func (h *handlers) addSource(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Source string          `json:"source"`
		Desc   string          `json:"desc"`
		Sample json.RawMessage `json:"sample"`
	}
	if !decode(w, r, &body) {
		return
	}
	src := strings.TrimSpace(body.Source)
	switch {
	case src == "":
		writeJSON(w, 422, issues(validate.Issue{Key: "source", Message: "Nguồn cần một tên, ví dụ plc/prs-02/status."}))
		return
	case len(src) > 200 || strings.ContainsAny(src, " \t\n"):
		writeJSON(w, 422, issues(validate.Issue{Key: "source", Message: "Tên nguồn không có khoảng trắng và dài tối đa 200 ký tự."}))
		return
	case len(body.Sample) > 0 && !json.Valid(body.Sample):
		writeJSON(w, 422, issues(validate.Issue{Key: "sample", Message: "Bản tin mẫu không phải JSON hợp lệ."}))
		return
	}
	now := time.Now()
	err := h.Store.UpsertSources(r.Context(), []store.DataSource{{Source: src, Desc: strings.TrimSpace(body.Desc),
		Origin: "manual", FirstSeen: now, LastSeen: now, Sample: body.Sample}})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 201, map[string]string{"source": src})
}

// deleteSource: DELETE /api/sources?source=...&cascade=true. Nguồn là toàn cục nên xoá là xoá cho mọi mô hình, và
// ghép nối đi theo cũng tính ở mọi nơi: của thiết bị lẫn của đường nối trong từng mô hình. Đang được ghép thì hỏi
// trước (409 kèm số ghép nối). Chỉ tính ghép nối ghi đúng tên nguồn này: ghép nối dùng ký tự thay thế (+, #) còn
// phục vụ các nguồn khác nên giữ lại.
func (h *handlers) deleteSource(w http.ResponseWriter, r *http.Request) {
	src := r.URL.Query().Get("source")
	if src == "" {
		writeJSON(w, 422, issues(validate.Issue{Key: "source", Message: "Thiếu tên nguồn cần xoá."}))
		return
	}
	ctx := r.Context()
	bs, err := h.Store.ListStoredBindings(ctx)
	if err != nil {
		writeErr(w, err)
		return
	}
	var dependents []live.Binding
	for _, b := range bs {
		if b.Source == src {
			dependents = append(dependents, b)
		}
	}
	if len(dependents) > 0 && r.URL.Query().Get("cascade") != "true" {
		writeErr(w, &store.ImpactError{Impact: map[string]int{"bindings": len(dependents)}})
		return
	}
	if err := h.Store.DeleteSource(ctx, src); err != nil {
		writeErr(w, err)
		return
	}
	for _, b := range dependents {
		if err := h.Store.DeleteBinding(ctx, b.ModelKey, b.ID); err != nil {
			writeErr(w, err)
			return
		}
	}
	if len(dependents) > 0 {
		if err := h.Live.ReloadBindings(ctx); err != nil {
			writeErr(w, err)
			return
		}
	}
	w.WriteHeader(204)
}

type testReading struct {
	Model   string   `json:"model,omitempty"` // rỗng: ghép nối của thiết bị, dùng chung
	Subject string   `json:"subject"`
	Signal  string   `json:"signal"`
	Value   *float64 `json:"value,omitempty"` // con trỏ: giá trị 0 vẫn phải có mặt trong JSON
	Text    string   `json:"text,omitempty"`
}

// testSource: POST /api/sources/test. Chạy thử một bản tin qua mọi ghép nối dùng nguồn đó — của thiết bị (một lần,
// không lặp theo từng mô hình chứa nó) và của đường nối trong từng mô hình — mà không ghi vào dữ liệu live.
func (h *handlers) testSource(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Source  string `json:"source"`
		Payload any    `json:"payload"`
	}
	if !decode(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Source) == "" {
		writeJSON(w, 422, issues(validate.Issue{Key: "source", Message: "Chọn nguồn để gửi thử."}))
		return
	}
	bs, err := h.Store.ListStoredBindings(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	// ListStoredBindings xếp theo mô hình, nên các nhóm liền nhau: ghép nối thiết bị (model rỗng) trước.
	matched := 0
	readings := []testReading{}
	msgs := []string{}
	msg := live.Message{Source: body.Source, TS: time.Now(), Payload: body.Payload}
	for i := 0; i < len(bs); {
		j := i
		for j < len(bs) && bs[j].ModelKey == bs[i].ModelKey {
			if bs[j].Enabled && live.MatchSource(bs[j].Source, body.Source) {
				matched++
			}
			j++
		}
		rs, errs := live.Normalize(bs[i].ModelKey, bs[i:j], msg)
		for _, x := range rs {
			t := testReading{Model: x.Model, Subject: x.Subject, Signal: x.Signal}
			switch {
			case x.Fleet != nil:
				t.Text = "xe " + x.Fleet.ID
			case x.IsText:
				t.Text = x.Text
			default:
				v := x.Num
				t.Value = &v
			}
			readings = append(readings, t)
		}
		for _, e := range errs {
			msgs = append(msgs, e.Error())
		}
		i = j
	}
	writeJSON(w, 200, map[string]any{"matched": matched, "readings": readings, "errors": msgs})
}
