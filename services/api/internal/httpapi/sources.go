package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/kaizenflow/api/internal/live"
	"github.com/kaizenflow/api/internal/store"
	"github.com/kaizenflow/api/internal/validate"
)

// liveSilentAfter: nguồn không có bản tin quá khoảng này (giờ thật) thì coi là mất tín hiệu, cùng ngưỡng với trạng thái node.
const liveSilentAfter = 15 * time.Second

type bindingRef struct {
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
			out = append(out, bindingRef{b.Subject, b.Signal})
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

// addSource: POST /api/models/{key}/sources. Người dùng khai báo một nguồn bằng cách dán bản tin mẫu.
func (h *handlers) addSource(w http.ResponseWriter, r *http.Request) {
	model := chi.URLParam(r, "key")
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
	if !h.modelExists(w, r, model) {
		return
	}
	now := time.Now()
	err := h.Store.UpsertSources(r.Context(), []store.DataSource{{ModelKey: model, Source: src, Desc: strings.TrimSpace(body.Desc),
		Origin: "manual", FirstSeen: now, LastSeen: now, Sample: body.Sample}})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 201, map[string]string{"source": src})
}

// deleteSource: DELETE /api/models/{key}/sources?source=...&cascade=true. Nguồn đang được ghép thì hỏi trước (409 kèm số ghép nối).
func (h *handlers) deleteSource(w http.ResponseWriter, r *http.Request) {
	model := chi.URLParam(r, "key")
	src := r.URL.Query().Get("source")
	if src == "" {
		writeJSON(w, 422, issues(validate.Issue{Key: "source", Message: "Thiếu tên nguồn cần xoá."}))
		return
	}
	ctx := r.Context()
	bs, err := h.Store.ListBindings(ctx, model)
	if err != nil {
		writeErr(w, err)
		return
	}
	var dependents []live.Binding
	for _, b := range bs {
		if live.MatchSource(b.Source, src) {
			dependents = append(dependents, b)
		}
	}
	if len(dependents) > 0 && r.URL.Query().Get("cascade") != "true" {
		writeErr(w, &store.ImpactError{Impact: map[string]int{"bindings": len(dependents)}})
		return
	}
	if err := h.Store.DeleteSource(ctx, model, src); err != nil {
		writeErr(w, err)
		return
	}
	for _, b := range dependents {
		if err := h.Store.DeleteBinding(ctx, model, b.ID); err != nil {
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
	Subject string   `json:"subject"`
	Signal  string   `json:"signal"`
	Value   *float64 `json:"value,omitempty"` // con trỏ: giá trị 0 vẫn phải có mặt trong JSON
	Text    string   `json:"text,omitempty"`
}

// testSource: POST /api/models/{key}/sources/test. Chạy thử một bản tin qua các ghép nối của mô hình mà không ghi vào dữ liệu live.
func (h *handlers) testSource(w http.ResponseWriter, r *http.Request) {
	model := chi.URLParam(r, "key")
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
	bs, err := h.Store.ListBindings(r.Context(), model)
	if err != nil {
		writeErr(w, err)
		return
	}
	matched := 0
	var all []live.Binding
	for _, b := range bs {
		if b.Enabled && live.MatchSource(b.Source, body.Source) {
			matched++
		}
		all = append(all, b)
	}
	rs, errs := live.Normalize(model, all, live.Message{Source: body.Source, TS: time.Now(), Payload: body.Payload})
	readings := make([]testReading, 0, len(rs))
	for _, x := range rs {
		t := testReading{Subject: x.Subject, Signal: x.Signal}
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
	msgs := make([]string, len(errs))
	for i, e := range errs {
		msgs[i] = e.Error()
	}
	writeJSON(w, 200, map[string]any{"matched": matched, "readings": readings, "errors": msgs})
}
