// Package livesvc nối đường ingest bản tin thô với trạng thái live, DB time-series và WebSocket.
package livesvc

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/kaizenflow/api/internal/live"
	"github.com/kaizenflow/api/internal/store"
)

// Store là phần của store mà service dùng (để test bằng bản giả).
type Store interface {
	AllBindings(ctx context.Context) ([]live.Binding, error)
	InsertLive(ctx context.Context, sigs []store.LiveSignal, evs []store.LiveEvent) error
	UpsertSources(ctx context.Context, list []store.DataSource) error
}

type Broadcaster interface{ Broadcast(v any) }

const (
	// persistGap: khoảng nghỉ tối thiểu (giờ ảo) giữa hai lần ghi DB của cùng một tín hiệu số.
	persistGap = 30 * time.Second
	// persistWallGap: khoảng nghỉ tối thiểu theo giờ thực. Feed chạy ×600 phát cách nhau hàng phút giờ ảo nên khoảng nghỉ giờ ảo
	// một mình không đủ: mọi tín hiệu sẽ được ghi ở mọi lần phát và bảng signal phình ra hàng triệu dòng mỗi giờ.
	persistWallGap = time.Second
	maxErrors      = 20
	// sourceWriteGap: khoảng nghỉ tối thiểu (giờ thật) giữa hai lần ghi DB của cùng một nguồn dữ liệu.
	sourceWriteGap = 10 * time.Second
	maxSourceAgg   = 10000
)

// alwaysPersist: tín hiệu rời rạc (mỗi mẫu là một chuyến xe) không được bỏ mẫu nào, vì hiệu chỉnh cần đủ mẫu.
var alwaysPersist = map[string]bool{"trip_s": true}

type ErrCount struct {
	Message string    `json:"message"`
	Count   int       `json:"count"`
	Last    time.Time `json:"last"`
}

type IngestResult struct {
	Accepted int `json:"accepted"`
	Rejected int `json:"rejected"`
	Readings int `json:"readings"`
	Errors   int `json:"errors"`
}

// LiveMsg là bản tin WebSocket: trạng thái một mô hình, không kèm danh sách nguồn (chỉ đếm).
type LiveMsg struct {
	Type     string                      `json:"type"`
	Model    string                      `json:"model"`
	Now      time.Time                   `json:"now"`
	Subjects map[string]live.SubjectSnap `json:"subjects"`
	Fleet    map[string][]live.Vehicle   `json:"fleet"`
	Sources  int                         `json:"sources"`
}

type Service struct {
	st    Store
	hub   Broadcaster
	state *live.State
	now   func() time.Time

	mu          sync.Mutex
	byModel     map[string][]live.Binding
	pendingSigs []store.LiveSignal
	pendingEvs  []store.LiveEvent
	lastPersist map[string]time.Time
	lastWall    map[string]time.Time
	lastState   map[string]string
	dirty       map[string]bool
	errs        map[string][]ErrCount
	srcAgg      map[string]*srcAgg   // "mô hình|nguồn" → số bản tin và mẫu chưa ghi
	srcFlushed  map[string]time.Time // lần ghi DB gần nhất của từng nguồn
}

// srcAgg gom các bản tin của một nguồn giữa hai lần ghi DB.
type srcAgg struct {
	model, source, desc string
	first, last         time.Time
	count               int64
	sample              any
}

func New(st Store, hub Broadcaster) *Service {
	return &Service{st: st, hub: hub, state: live.NewState(), now: time.Now,
		byModel: map[string][]live.Binding{}, lastPersist: map[string]time.Time{}, lastWall: map[string]time.Time{}, lastState: map[string]string{},
		dirty: map[string]bool{}, errs: map[string][]ErrCount{}, srcAgg: map[string]*srcAgg{}, srcFlushed: map[string]time.Time{}}
}

func (s *Service) State() *live.State { return s.state }

// ReloadBindings nạp lại mapping từ DB (gọi sau mỗi lần sửa mapping).
func (s *Service) ReloadBindings(ctx context.Context) error {
	all, err := s.st.AllBindings(ctx)
	if err != nil {
		return err
	}
	by := map[string][]live.Binding{}
	for _, b := range all {
		by[b.ModelKey] = append(by[b.ModelKey], b)
	}
	s.mu.Lock()
	s.byModel = by
	s.mu.Unlock()
	return nil
}

func (s *Service) bindingsOf(model string) []live.Binding {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.byModel[model]
}

// Ingest chuẩn hoá một lô bản tin không nói rõ của mô hình nào: nguồn được ghi nhận cho những mô hình có ghép nối khớp nó.
func (s *Service) Ingest(msgs []live.Message) IngestResult { return s.IngestFor("", msgs) }

// IngestFor chuẩn hoá một lô bản tin. model (nếu có, do feed gửi kèm) là mô hình mà các nguồn trong lô thuộc về.
// Bản tin hỏng bị đếm và bỏ, không làm hỏng cả lô.
func (s *Service) IngestFor(model string, msgs []live.Message) IngestResult {
	var res IngestResult
	wall := s.now()
	s.mu.Lock()
	byModel := make(map[string][]live.Binding, len(s.byModel))
	for k, v := range s.byModel {
		byModel[k] = v
	}
	s.mu.Unlock()
	for _, msg := range msgs {
		if msg.Source == "" || msg.TS.IsZero() {
			res.Rejected++
			continue
		}
		res.Accepted++
		s.state.NoteSource(msg, wall)
		s.noteSource(model, byModel, msg, wall)
		for model, bs := range byModel {
			rs, errs := live.Normalize(model, bs, msg)
			res.Readings += len(rs)
			res.Errors += len(errs)
			if len(rs) > 0 {
				s.state.Apply(model, rs, wall)
				s.queue(model, rs, wall)
			}
			for _, e := range errs {
				s.noteError(model, e.Error(), msg.TS)
			}
		}
	}
	return res
}

// noteSource ghi nhận nguồn của một bản tin để Flush ghi xuống bảng data_source.
func (s *Service) noteSource(model string, byModel map[string][]live.Binding, msg live.Message, wall time.Time) {
	var owners []string
	if model != "" {
		owners = []string{model}
	} else {
		for m, bs := range byModel {
			for _, b := range bs {
				if b.Enabled && live.MatchSource(b.Source, msg.Source) {
					owners = append(owners, m)
					break
				}
			}
		}
	}
	if len(owners) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, m := range owners {
		k := m + "|" + msg.Source
		a := s.srcAgg[k]
		if a == nil {
			if len(s.srcAgg) >= maxSourceAgg {
				continue
			}
			a = &srcAgg{model: m, source: msg.Source, first: wall}
			s.srcAgg[k] = a
		}
		a.last = wall
		a.count++
		if msg.Desc != "" {
			a.desc = msg.Desc
		}
		a.sample = msg.Payload
	}
}

func (s *Service) noteError(model, msg string, at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.errs[model]
	for i := range list {
		if list[i].Message == msg {
			list[i].Count++
			list[i].Last = at
			return
		}
	}
	if len(list) >= maxErrors {
		list = list[1:]
	}
	s.errs[model] = append(list, ErrCount{Message: msg, Count: 1, Last: at})
}

// RecentErrors trả các lỗi ghép nối gần đây (đã gộp theo nội dung) của một mô hình.
func (s *Service) RecentErrors(model string) []ErrCount {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]ErrCount(nil), s.errs[model]...)
}

func (s *Service) queue(model string, rs []live.Reading, wall time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dirty[model] = true
	for _, r := range rs {
		if r.Fleet != nil {
			continue
		}
		key := model + "|" + r.Subject
		if r.IsText {
			if s.lastState[key] != r.Text {
				s.lastState[key] = r.Text
				s.pendingEvs = append(s.pendingEvs, store.LiveEvent{Time: r.TS, Model: model, Subject: r.Subject,
					Type: "STATE", Payload: map[string]any{"state": r.Text}})
			}
			continue
		}
		pk := key + "|" + r.Signal
		if !alwaysPersist[r.Signal] {
			if last, ok := s.lastPersist[pk]; ok && r.TS.Sub(last) >= 0 && r.TS.Sub(last) < persistGap {
				continue
			}
			if lw, ok := s.lastWall[pk]; ok && wall.Sub(lw) < persistWallGap {
				continue
			}
		}
		s.lastPersist[pk], s.lastWall[pk] = r.TS, wall
		s.pendingSigs = append(s.pendingSigs, store.LiveSignal{Time: r.TS, Model: model, Subject: r.Subject, Name: r.Signal, Value: r.Num})
	}
}

// Flush ghi các tín hiệu và sự kiện đang chờ xuống DB.
func (s *Service) Flush(ctx context.Context) error {
	s.mu.Lock()
	sigs, evs := s.pendingSigs, s.pendingEvs
	s.pendingSigs, s.pendingEvs = nil, nil
	s.mu.Unlock()
	if err := s.st.InsertLive(ctx, sigs, evs); err != nil {
		return err
	}
	return s.flushSources(ctx)
}

// flushSources ghi các nguồn có bản tin mới, mỗi nguồn tối đa một lần mỗi sourceWriteGap. Ghi lỗi thì trả lại số đếm để lần sau ghi bù.
func (s *Service) flushSources(ctx context.Context) error {
	now := s.now()
	type sent struct {
		key   string
		count int64
	}
	var out []store.DataSource
	var done []sent
	s.mu.Lock()
	for k, a := range s.srcAgg {
		if a.count == 0 {
			continue
		}
		if last, ok := s.srcFlushed[k]; ok && now.Sub(last) < sourceWriteGap {
			continue
		}
		var sample json.RawMessage
		if a.sample != nil {
			sample, _ = json.Marshal(a.sample)
		}
		out = append(out, store.DataSource{ModelKey: a.model, Source: a.source, Desc: a.desc, Origin: "feed",
			FirstSeen: a.first, LastSeen: a.last, Count: a.count, Sample: sample})
		done = append(done, sent{k, a.count})
		a.count = 0
		s.srcFlushed[k] = now
	}
	s.mu.Unlock()
	if len(out) == 0 {
		return nil
	}
	err := s.st.UpsertSources(ctx, out)
	if err != nil {
		s.mu.Lock()
		for _, d := range done {
			if a := s.srcAgg[d.key]; a != nil {
				a.count += d.count
			}
			delete(s.srcFlushed, d.key)
		}
		s.mu.Unlock()
	}
	return err
}

// Snapshot chụp trạng thái live của một mô hình.
func (s *Service) Snapshot(model string) live.Snapshot {
	return s.state.Snapshot(model, s.now(), s.bindingsOf(model))
}

// BroadcastDirty phát trạng thái của các mô hình có dữ liệu mới từ lần phát trước.
func (s *Service) BroadcastDirty() {
	s.mu.Lock()
	var models []string
	for m, d := range s.dirty {
		if d {
			models = append(models, m)
			s.dirty[m] = false
		}
	}
	s.mu.Unlock()
	for _, m := range models {
		snap := s.Snapshot(m)
		s.hub.Broadcast(LiveMsg{Type: "live", Model: m, Now: snap.Now, Subjects: snap.Subjects, Fleet: snap.Fleet, Sources: len(snap.Sources)})
	}
}

// Clear đặt lại trạng thái live của một mô hình (không xoá DB; việc đó do store.ClearLive).
func (s *Service) Clear(model string) {
	s.state.Clear(model)
	s.state.ClearSources()
	s.mu.Lock()
	defer s.mu.Unlock()
	prefix := model + "|"
	for k := range s.lastPersist {
		if strings.HasPrefix(k, prefix) {
			delete(s.lastPersist, k)
		}
	}
	for k := range s.lastWall {
		if strings.HasPrefix(k, prefix) {
			delete(s.lastWall, k)
		}
	}
	for k := range s.lastState {
		if strings.HasPrefix(k, prefix) {
			delete(s.lastState, k)
		}
	}
	delete(s.errs, model)
	delete(s.dirty, model)
	// Hàng đợi ghi DB: bỏ dòng của mô hình này, nếu không chúng được ghi sau khi đã xoá.
	sigs := s.pendingSigs[:0]
	for _, r := range s.pendingSigs {
		if r.Model != model {
			sigs = append(sigs, r)
		}
	}
	s.pendingSigs = sigs
	evs := s.pendingEvs[:0]
	for _, e := range s.pendingEvs {
		if e.Model != model {
			evs = append(evs, e)
		}
	}
	s.pendingEvs = evs
}

// Run ghi DB mỗi giây và phát WebSocket mỗi 400 ms cho đến khi ctx kết thúc.
func (s *Service) Run(ctx context.Context) {
	flush := time.NewTicker(time.Second)
	push := time.NewTicker(400 * time.Millisecond)
	defer flush.Stop()
	defer push.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-flush.C:
			if err := s.Flush(ctx); err != nil && ctx.Err() == nil {
				log.Printf("live flush: %v", err)
			}
		case <-push.C:
			s.BroadcastDirty()
		}
	}
}
