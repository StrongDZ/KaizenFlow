package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// Alerts turn the states the UI shows into problems somebody is told about:
// an edge that stopped reporting, a machine whose gauges all went silent, a
// value outside its limits, a gauge that cannot be read for long. A problem
// must last for a while before it is raised, so a single late window raises
// nothing; it is cleared as soon as it is gone. Every change is posted to a
// webhook when one is configured (a Slack-style "text" field is included).
// The state lives in memory: after a restart the open problems are raised
// again once they have lasted long enough.

// Kinds of alert.
const (
	AlertEdgeOffline   = "edge_offline"
	AlertMachineSilent = "machine_silent"
	AlertOutOfRange    = "out_of_range"
	AlertUnreadable    = "unreadable"
)

// Severities.
const (
	SeverityCritical = "critical"
	SeverityWarning  = "warning"
)

// edgeOnline is the status an edge reports while it runs (edge_node.status).
const edgeOnline = "online"

// Alert is one open problem.
type Alert struct {
	Key       string   `json:"key"`
	Kind      string   `json:"kind"`
	Severity  string   `json:"severity"`
	Plant     string   `json:"plant,omitempty"`
	Line      string   `json:"line,omitempty"`
	MachineID string   `json:"machine_id,omitempty"`
	GaugeID   string   `json:"gauge_id,omitempty"`
	EdgeID    string   `json:"edge_id,omitempty"`
	Message   string   `json:"message"`
	Value     *float64 `json:"value,omitempty"`
	// Machines lists the machines of an edge that is offline.
	Machines []string `json:"machines,omitempty"`
	// Since is when the condition was first seen, not when it was raised.
	Since time.Time `json:"since"`
}

// Alerter keeps the open problems.
type Alerter struct {
	api     *API
	now     func() time.Time
	webhook string
	client  *http.Client
	// After is how long a problem must last before it is raised; Unreadable
	// is that time for a gauge whose readings cannot be trusted.
	After      time.Duration
	Unreadable time.Duration

	mu      sync.Mutex
	seen    map[string]time.Time // condition key -> first seen
	open    map[string]Alert
	active  *prometheus.GaugeVec
	posts   *prometheus.CounterVec
	lastErr string
}

func NewAlerter(api *API, webhook string, reg prometheus.Registerer) *Alerter {
	a := &Alerter{api: api, now: api.now, webhook: webhook, client: &http.Client{Timeout: 10 * time.Second},
		After: time.Minute, Unreadable: 10 * time.Minute, seen: map[string]time.Time{}, open: map[string]Alert{},
		active: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "gauge_twin_alerts_open", Help: "Open alerts, by kind."}, []string{"kind"}),
		posts: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "gauge_twin_alert_webhook_posts_total", Help: "Alert changes posted to the webhook, by result."}, []string{"result"})}
	reg.MustRegister(a.active, a.posts)
	return a
}

// conditions are the problems the current states show, keyed.
func (al *Alerter) conditions(views []stationView) map[string]Alert {
	out := map[string]Alert{}
	offline := map[string][]stationView{}
	for _, s := range views {
		if s.Edge != nil && s.Edge.Status != edgeOnline {
			offline[s.Edge.EdgeID] = append(offline[s.Edge.EdgeID], s)
		}
	}
	for edge, stations := range offline {
		machines := make([]string, 0, len(stations))
		for _, s := range stations {
			machines = append(machines, s.MachineID)
		}
		sort.Strings(machines)
		out["edge/"+edge] = Alert{Kind: AlertEdgeOffline, Severity: SeverityCritical, EdgeID: edge, Machines: machines,
			Plant: stations[0].Plant, Line: stations[0].Line,
			Message: fmt.Sprintf("Edge %s mất kết nối: %d máy không gửi số liệu (%s)", edge, len(machines), joinShort(machines, 4))}
	}
	for _, s := range views {
		edgeDown := s.Edge != nil && s.Edge.Status != edgeOnline
		// A station no edge ever reported is being set up, not silent.
		if s.State == StateOffline && s.Edge != nil && !edgeDown && len(s.Gauges) > 0 {
			out["silent/"+s.MachineID] = Alert{Kind: AlertMachineSilent, Severity: SeverityCritical, Plant: s.Plant, Line: s.Line,
				MachineID: s.MachineID, EdgeID: s.Edge.EdgeID,
				Message: fmt.Sprintf("Máy %s không còn số đọc mới từ cả %d đồng hồ (camera hoặc pipeline của edge %s)", s.MachineID, len(s.Gauges), s.Edge.EdgeID)}
		}
		if edgeDown {
			continue
		}
		for _, g := range s.Gauges {
			key := s.MachineID + "/" + g.GaugeID
			switch g.State {
			case StateAlarm:
				out["range/"+key] = Alert{Kind: AlertOutOfRange, Severity: SeverityWarning, Plant: s.Plant, Line: s.Line,
					MachineID: s.MachineID, GaugeID: g.GaugeID, Value: g.Value,
					Message: fmt.Sprintf("%s · %s: %s %s, ngoài giới hạn %s", s.MachineID, g.GaugeID, number(g.Value), g.Unit, limits(g.Min, g.Max))}
			case StatePoor:
				out["poor/"+key] = Alert{Kind: AlertUnreadable, Severity: SeverityWarning, Plant: s.Plant, Line: s.Line,
					MachineID: s.MachineID, GaugeID: g.GaugeID,
					Message: fmt.Sprintf("%s · %s %s kéo dài", s.MachineID, g.GaugeID, readingProblem(g.Flags))}
			}
		}
	}
	for k, v := range out {
		v.Key = k
		out[k] = v
	}
	return out
}

func (al *Alerter) wait(kind string) time.Duration {
	if kind == AlertUnreadable {
		return al.Unreadable
	}
	return al.After
}

// Step compares the current states with the open alerts and posts every
// change; it returns the changes.
func (al *Alerter) Step(ctx context.Context) ([]alertChange, error) {
	views, err := al.api.views(ctx, "")
	if err != nil {
		return nil, err
	}
	now := al.now()
	current := al.conditions(views)
	var changes []alertChange
	al.mu.Lock()
	for key, c := range current {
		first, ok := al.seen[key]
		if !ok {
			first = now
			al.seen[key] = now
		}
		c.Since = first
		if _, open := al.open[key]; open {
			al.open[key] = c // keep the message and value current
			continue
		}
		if now.Sub(first) >= al.wait(c.Kind) {
			al.open[key] = c
			changes = append(changes, alertChange{Status: "firing", Alert: c})
		}
	}
	for key := range al.seen {
		if _, still := current[key]; still {
			continue
		}
		delete(al.seen, key)
		if a, open := al.open[key]; open {
			delete(al.open, key)
			changes = append(changes, alertChange{Status: "resolved", Alert: a})
		}
	}
	count := map[string]float64{AlertEdgeOffline: 0, AlertMachineSilent: 0, AlertOutOfRange: 0, AlertUnreadable: 0}
	for _, a := range al.open {
		count[a.Kind]++
	}
	al.mu.Unlock()
	for kind, n := range count {
		al.active.WithLabelValues(kind).Set(n)
	}
	for _, c := range changes {
		al.post(ctx, c)
	}
	return changes, nil
}

type alertChange struct {
	Status string `json:"status"` // firing or resolved
	Alert  Alert  `json:"alert"`
	// Text is the message for chat webhooks (Slack, Mattermost, Google Chat).
	Text string `json:"text"`
}

func (al *Alerter) post(ctx context.Context, c alertChange) {
	if al.webhook == "" {
		return
	}
	prefix := "🔴"
	if c.Alert.Severity == SeverityWarning {
		prefix = "🟠"
	}
	if c.Status == "resolved" {
		prefix = "✅ Đã hết:"
	}
	c.Text = prefix + " " + c.Alert.Message
	body, _ := json.Marshal(c)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, al.webhook, bytes.NewReader(body))
	if err == nil {
		req.Header.Set("Content-Type", "application/json")
		var resp *http.Response
		if resp, err = al.client.Do(req); err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode >= 300 {
				err = fmt.Errorf("webhook answered %s", resp.Status)
			}
		}
	}
	al.mu.Lock()
	defer al.mu.Unlock()
	if err != nil {
		al.posts.WithLabelValues("error").Inc()
		al.lastErr = err.Error()
		al.api.logger.Warn("alert webhook", "error", err, "alert", c.Alert.Key)
		return
	}
	al.posts.WithLabelValues("ok").Inc()
	al.lastErr = ""
}

// Run steps every period until ctx ends.
func (al *Alerter) Run(ctx context.Context, every time.Duration) {
	for {
		if _, err := al.Step(ctx); err != nil && ctx.Err() == nil {
			al.api.logger.Warn("alerts", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
	}
}

// Open lists the open alerts, critical first, then the oldest.
func (al *Alerter) Open() []Alert {
	al.mu.Lock()
	defer al.mu.Unlock()
	out := make([]Alert, 0, len(al.open))
	for _, a := range al.open {
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Severity != out[j].Severity {
			return out[i].Severity == SeverityCritical
		}
		if !out[i].Since.Equal(out[j].Since) {
			return out[i].Since.Before(out[j].Since)
		}
		return out[i].Key < out[j].Key
	})
	return out
}

type alertsView struct {
	Alerts  []Alert `json:"alerts"`
	Webhook bool    `json:"webhook"`
	// WebhookError is the last failure to post, empty when the last post worked.
	WebhookError string `json:"webhook_error,omitempty"`
}

func (al *Alerter) handle(w http.ResponseWriter, _ *http.Request) int {
	al.mu.Lock()
	lastErr := al.lastErr
	al.mu.Unlock()
	return writeJSON(w, http.StatusOK, alertsView{Alerts: al.Open(), Webhook: al.webhook != "", WebhookError: lastErr})
}

// problemLabels name the flags of an unreadable gauge the way the UI does.
var problemLabels = map[string]string{
	"FLAG_BLUR": "ảnh mờ", "FLAG_GLARE": "bị lóa", "FLAG_OCCLUDED": "bị che", "FLAG_FORMAT_INVALID": "đọc sai định dạng",
	"FLAG_ROI_DRIFT": "camera xê dịch",
}

// readingProblem says why a gauge cannot be trusted, in words.
func readingProblem(flags []string) string {
	var out []string
	for _, f := range flags {
		if label, ok := problemLabels[f]; ok {
			out = append(out, label)
		}
	}
	if len(out) == 0 {
		return "độ tin cậy thấp"
	}
	return strings.Join(out, ", ")
}

func number(v *float64) string {
	if v == nil {
		return "—"
	}
	return strconv.FormatFloat(*v, 'f', -1, 64)
}

func limits(lo, hi *float64) string {
	switch {
	case lo != nil && hi != nil:
		return number(lo) + "…" + number(hi)
	case hi != nil:
		return "≤ " + number(hi)
	case lo != nil:
		return "≥ " + number(lo)
	}
	return "của thang đo"
}

func joinShort(items []string, most int) string {
	if len(items) == 0 {
		return "không có cờ"
	}
	if len(items) <= most {
		return fmt.Sprint(items)[1 : len(fmt.Sprint(items))-1]
	}
	return fmt.Sprintf("%s và %d nữa", fmt.Sprint(items[:most])[1:len(fmt.Sprint(items[:most]))-1], len(items)-most)
}
